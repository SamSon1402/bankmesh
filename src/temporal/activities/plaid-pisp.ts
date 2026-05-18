import { Context, heartbeat } from '@temporalio/activity';
import { prisma } from '../../lib/prisma';
import { createHash } from 'node:crypto';

/**
 * PISP (Payment Initiation Service Provider) activities.
 *
 * Plaid Payments — submit a transfer, deal with the SCA challenge,
 * poll until settlement. Same idempotency-key story as PayrollPilot:
 * deterministic key from the sweep id + amount means a Temporal retry
 * after a network timeout doesn't double-move the money.
 */

export class InsufficientFundsError extends Error { constructor(m: string) { super(m); this.name = 'InsufficientFundsError'; } }
export class AccountFrozenError extends Error { constructor(m: string) { super(m); this.name = 'AccountFrozenError'; } }

function transferIdempotencyKey(sweepId: string, amountMinor: number): string {
  const hash = createHash('sha256')
    .update(`sweep:${sweepId}:${amountMinor}`)
    .digest('hex')
    .slice(0, 32);
  return `bm_${hash}`;
}

export async function submitPlaidTransfer(args: { sweepId: string }): Promise<{
  plaidTransferId: string;
  scaChallengeId?: string;
}> {
  const sweep = await prisma.sweep.findUniqueOrThrow({
    where: { id: args.sweepId },
    include: { fromAccount: true, toAccount: true },
  });

  const amountMinor = Math.round(Number(sweep.amount) * 100);
  const idempotencyKey = transferIdempotencyKey(args.sweepId, amountMinor);

  // TODO: real call
  //   const resp = await plaid.transferCreate({
  //     idempotency_key: idempotencyKey,
  //     access_token: ..., account_id: sweep.fromAccount.plaidAccountId,
  //     amount: (amountMinor / 100).toFixed(2),
  //     iso_currency_code: sweep.currency,
  //     description: 'BankMesh sweep',
  //     // ... etc
  //   });
  //   return {
  //     plaidTransferId: resp.data.transfer.id,
  //     scaChallengeId: resp.data.sca?.challenge_id,
  //   };

  // Stub mirroring real response shape:
  const plaidTransferId = `xfr_${idempotencyKey}`;
  const scaChallengeId = sweep.scaRequired ? `sca_${idempotencyKey}` : undefined;

  await prisma.sweep.update({
    where: { id: args.sweepId },
    data: { plaidTransferId, scaChallengeId: scaChallengeId ?? null },
  });

  return { plaidTransferId, scaChallengeId };
}

export async function awaitTransferSettlement(args: {
  sweepId: string;
  plaidTransferId: string;
}): Promise<{ status: 'SETTLED' | 'FAILED' | 'CANCELLED' }> {
  // Settlement for UK Faster Payments is usually < 30s, sometimes
  // longer for cross-bank. Cap at 30 minutes; if it's not done by
  // then something is wrong and ops needs to look.
  const deadline = Date.now() + 30 * 60 * 1000;
  const ctx = Context.current();

  while (Date.now() < deadline) {
    // TODO: real status query
    //   const resp = await plaid.transferGet({ transfer_id: args.plaidTransferId });
    //   const status = resp.data.transfer.status;  // 'pending' | 'posted' | 'cancelled' | 'failed' | 'returned'
    const status = await pollStub(args.plaidTransferId);

    if (status === 'posted')   return { status: 'SETTLED' };
    if (status === 'failed' || status === 'returned')   return { status: 'FAILED' };
    if (status === 'cancelled') return { status: 'CANCELLED' };

    heartbeat('polling');
    await sleep(5000);
    if (ctx.cancellationSignal.aborted) throw new Error('settlement polling cancelled');
  }
  return { status: 'FAILED' };
}

async function pollStub(_id: string): Promise<'pending' | 'posted' | 'failed' | 'cancelled' | 'returned'> {
  return 'posted';
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
