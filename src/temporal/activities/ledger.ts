import { prisma } from '../../lib/prisma';

/**
 * Apply a completed sweep to the local ledger.
 *
 * Once Plaid confirms settlement we update our denormalised
 * `currentBalance` fields on both accounts AND write a balance
 * snapshot of source `RECONCILIATION` so the time series stays
 * honest (the next AISP refresh would correct any drift, but
 * waiting for it would leave the UI showing stale numbers for up
 * to a few minutes).
 */

export async function applySweepToLedger(args: { sweepId: string }): Promise<void> {
  const sweep = await prisma.sweep.findUniqueOrThrow({
    where: { id: args.sweepId },
    include: { fromAccount: true, toAccount: true },
  });
  const amount = Number(sweep.amount);

  await prisma.$transaction([
    prisma.account.update({
      where: { id: sweep.fromAccountId },
      data: { currentBalance: { decrement: amount }, asOf: new Date() },
    }),
    prisma.account.update({
      where: { id: sweep.toAccountId },
      data: { currentBalance: { increment: amount }, asOf: new Date() },
    }),
    prisma.balanceSnapshot.create({
      data: {
        accountId: sweep.fromAccountId,
        current: Number(sweep.fromAccount.currentBalance) - amount,
        currency: sweep.fromAccount.currency,
        source: 'RECONCILIATION',
      },
    }),
    prisma.balanceSnapshot.create({
      data: {
        accountId: sweep.toAccountId,
        current: Number(sweep.toAccount.currentBalance) + amount,
        currency: sweep.toAccount.currency,
        source: 'RECONCILIATION',
      },
    }),
    prisma.sweep.update({
      where: { id: args.sweepId },
      data: { executedAt: new Date() },
    }),
  ]);
}
