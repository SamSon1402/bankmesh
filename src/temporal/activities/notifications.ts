import { prisma } from '../../lib/prisma';

/**
 * Notification activities — Slack today, email next.
 *
 * Production wires `@slack/web-api`. Kept thin so the workflow can
 * stay focused on the state machine.
 */

export async function notifySweepCompleted(args: { sweepId: string }): Promise<void> {
  const sweep = await prisma.sweep.findUniqueOrThrow({
    where: { id: args.sweepId },
    include: { fromAccount: true, toAccount: true },
  });
  console.log(
    `[slack #treasury-ops] sweep completed: ${sweep.fromAccount.bankName} → ${sweep.toAccount.bankName}: ` +
    `${sweep.currency} ${sweep.amount}`
  );
}

export async function notifyConsentExpiring(args: { plaidItemId: string }): Promise<void> {
  const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: args.plaidItemId } });
  console.log(
    `[slack #treasury-ops] consent expiring soon for ${item.institutionName}: ${item.consentExpiresAt.toISOString()}`
  );
}
