import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getTemporalClient } from '@/lib/temporal-client';

/**
 * POST /api/sweeps/[id]/approve
 *
 * Deliver the operator's decision to the paused sweep workflow.
 * Same DB-first dual-write pattern as the other two services:
 * persist the decision before signalling Temporal.
 */

export const runtime = 'nodejs';

const Body = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  approverId: z.string(),
  reason: z.string().max(500).optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } }
): Promise<NextResponse> {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 });
  }
  const { decision, approverId, reason } = parsed.data;

  const sweep = await prisma.sweep.findUnique({ where: { id: ctx.params.id } });
  if (!sweep) return NextResponse.json({ error: 'sweep_not_found' }, { status: 404 });
  if (sweep.state !== 'PENDING_APPROVAL') {
    return NextResponse.json(
      { error: 'sweep_not_pending_approval', currentState: sweep.state },
      { status: 409 }
    );
  }

  // 1) Persist
  await prisma.$transaction([
    prisma.sweep.update({
      where: { id: sweep.id },
      data: decision === 'APPROVED'
        ? { approvedBy: approverId, approvedAt: new Date() }
        : { state: 'CANCELLED', rejectedReason: reason ?? null },
    }),
    prisma.sweepEvent.create({
      data: {
        sweepId: sweep.id,
        eventType: decision === 'APPROVED' ? 'APPROVED' : 'REJECTED',
        payload: { approverId, reason } as never,
      },
    }),
  ]);

  // 2) Signal Temporal
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(`sweep-${sweep.id}`);
  try {
    await handle.signal('approval', { decision, approverId, reason });
  } catch (err) {
    console.error('temporal.signal.failed', err);
    return NextResponse.json({ ok: false, warning: 'workflow_no_longer_running' }, { status: 202 });
  }

  return NextResponse.json({ ok: true });
}
