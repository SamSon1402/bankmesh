import { prisma } from '../../lib/prisma';
import type { SweepState } from '@prisma/client';

/**
 * Sweep state-management activities — pure DB writes, kept thin so the
 * workflow's state machine reads cleanly.
 */

export async function classifySweep(args: { sweepId: string }): Promise<{
  approvalRequired: boolean;
  scaRequired: boolean;
}> {
  // Re-read at workflow start; if the world changed between propose
  // and start, we want fresh classification.
  const sweep = await prisma.sweep.findUniqueOrThrow({
    where: { id: args.sweepId },
    include: { fromAccount: true, toAccount: true, policy: true },
  });

  const amount = Number(sweep.amount);
  const crossBank = sweep.fromAccount.bankName !== sweep.toAccount.bankName;
  return {
    approvalRequired: amount > 50_000,
    scaRequired: sweep.scaRequired || (crossBank && amount > 30_000),
  };
}

export async function setSweepState(args: { sweepId: string; state: SweepState }): Promise<void> {
  await prisma.sweep.update({
    where: { id: args.sweepId },
    data: { state: args.state },
  });
}

export async function recordSweepEvent(args: {
  sweepId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await prisma.sweepEvent.create({
    data: {
      sweepId: args.sweepId,
      eventType: args.eventType,
      payload: args.payload as never,
    },
  });
}

export async function recordSweepDecision(args: {
  sweepId: string;
  decision: 'APPROVED' | 'REJECTED';
  approverId: string;
  reason?: string;
}): Promise<void> {
  await prisma.sweep.update({
    where: { id: args.sweepId },
    data: args.decision === 'APPROVED'
      ? { approvedBy: args.approverId, approvedAt: new Date() }
      : { state: 'CANCELLED', rejectedReason: args.reason ?? null },
  });
}

export async function markScaCompleted(args: { sweepId: string }): Promise<void> {
  await prisma.sweep.update({
    where: { id: args.sweepId },
    data: { scaCompletedAt: new Date(), state: 'EXECUTING' },
  });
}

export async function failSweep(args: { sweepId: string; reason: string }): Promise<void> {
  await prisma.sweep.update({
    where: { id: args.sweepId },
    data: { state: 'FAILED', failureReason: args.reason },
  });
  await prisma.sweepEvent.create({
    data: { sweepId: args.sweepId, eventType: 'FAILED', payload: { reason: args.reason } as never },
  });
}
