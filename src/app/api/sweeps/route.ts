import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getTemporalClient, TASK_QUEUE } from '@/lib/temporal-client';

/**
 * POST /api/sweeps
 *
 * Either manual ("treasury wants to move £20k now") or policy-driven
 * (the scheduler workflow calls this). Creates the Sweep row, kicks
 * off the Temporal workflow.
 *
 *   curl -X POST http://localhost:3000/api/sweeps \
 *     -H "content-type: application/json" \
 *     -d '{
 *       "fromAccountId":"<hsbc-id>",
 *       "toAccountId":"<mmf-id>",
 *       "amount":68000,
 *       "currency":"GBP",
 *       "reason":"manual sweep — Q1 surplus"
 *     }'
 */

export const runtime = 'nodejs';

const Body = z.object({
  fromAccountId: z.string(),
  toAccountId: z.string(),
  amount: z.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reason: z.string().max(500),
  policyId: z.string().optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  const [fromAccount, toAccount] = await Promise.all([
    prisma.account.findUnique({ where: { id: body.fromAccountId } }),
    prisma.account.findUnique({ where: { id: body.toAccountId } }),
  ]);

  if (!fromAccount || !toAccount) {
    return NextResponse.json({ error: 'account_not_found' }, { status: 404 });
  }
  if (fromAccount.currency !== body.currency || toAccount.currency !== body.currency) {
    // Cross-currency sweeps need to go through the FX rebalance path,
    // not direct transfer. Surface explicitly rather than silently
    // failing inside the workflow.
    return NextResponse.json({ error: 'currency_mismatch_use_fx_rebalance' }, { status: 400 });
  }

  let policyVersion: number | undefined;
  if (body.policyId) {
    const p = await prisma.policy.findUnique({ where: { id: body.policyId } });
    if (!p) return NextResponse.json({ error: 'policy_not_found' }, { status: 404 });
    policyVersion = p.version;
  }

  const sweep = await prisma.sweep.create({
    data: {
      fromAccountId: body.fromAccountId,
      toAccountId: body.toAccountId,
      amount: body.amount,
      currency: body.currency,
      reason: body.reason,
      policyId: body.policyId ?? null,
      policyVersion: policyVersion ?? null,
      // Pre-classify SCA based on amount; the workflow re-classifies
      // on start with current data.
      scaRequired: body.amount > 30_000,
    },
  });

  const client = await getTemporalClient();
  const handle = await client.workflow.start('sweepWorkflow', {
    args: [{ sweepId: sweep.id }],
    taskQueue: TASK_QUEUE,
    workflowId: `sweep-${sweep.id}`,
  });

  return NextResponse.json({
    sweepId: sweep.id,
    temporalWorkflowId: handle.workflowId,
    state: 'PROPOSED',
  }, { status: 202 });
}
