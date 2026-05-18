import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { PolicyRules } from '@/policy/types';
import { evaluatePolicy } from '@/policy/evaluator';

/**
 * POST /api/policies/[id]/evaluate
 *
 * Dry-run a policy against the current balance snapshot — return the
 * sweeps that WOULD be proposed, without queueing any. Used by the
 * "preview" button in the policy builder and by ops to debug
 * misfiring rules.
 *
 *   curl -X POST http://localhost:3000/api/policies/<id>/evaluate
 */

export const runtime = 'nodejs';

export async function POST(
  _req: NextRequest,
  ctx: { params: { id: string } }
): Promise<NextResponse> {
  const policy = await prisma.policy.findUnique({ where: { id: ctx.params.id } });
  if (!policy) return NextResponse.json({ error: 'policy_not_found' }, { status: 404 });

  const rulesParsed = PolicyRules.safeParse(policy.rules);
  if (!rulesParsed.success) {
    return NextResponse.json(
      { error: 'corrupt_policy_rules', issues: rulesParsed.error.issues },
      { status: 500 }
    );
  }

  const accounts = await prisma.account.findMany();

  const result = evaluatePolicy(rulesParsed.data, accounts);

  return NextResponse.json({
    policyId: policy.id,
    version: policy.version,
    asOf: new Date().toISOString(),
    proposed: result.proposed,
    skipped: result.skipped,
  });
}
