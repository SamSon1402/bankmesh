import { prisma } from '../../lib/prisma';
import { getPlaidClient } from '../../lib/plaid';
import { decryptAccessToken } from '../../lib/crypto';
import type { PlaidItem } from '@prisma/client';

/**
 * AISP (Account Information Service Provider) activities.
 *
 * Two responsibilities:
 *   - read live balances and persist snapshots
 *   - track consent lifecycle (90-day TPP rules) and surface re-auth
 *     before the consent dies silently
 */

export class PlaidConsentExpiredError extends Error {
  constructor(itemId: string) {
    super(`Plaid consent expired for item ${itemId}`);
    this.name = 'PlaidConsentExpiredError';
  }
}

export async function listHealthyPlaidItems(): Promise<{ id: string }[]> {
  return prisma.plaidItem.findMany({
    where: { status: { in: ['HEALTHY', 'CONSENT_EXPIRING'] } },
    select: { id: true },
  });
}

const CONSENT_EXPIRY_WARNING_DAYS = 7;

export async function refreshItemBalances(args: { plaidItemId: string }): Promise<{
  snapshotCount: number;
  consentExpiringSoon: boolean;
}> {
  const item = await prisma.plaidItem.findUniqueOrThrow({
    where: { id: args.plaidItemId },
    include: { accounts: true },
  });

  // Check consent freshness before making the API call.
  const daysUntilExpiry = Math.floor(
    (item.consentExpiresAt.getTime() - Date.now()) / 86_400_000
  );
  if (daysUntilExpiry < 0) {
    await prisma.plaidItem.update({
      where: { id: item.id },
      data: { status: 'CONSENT_EXPIRED' },
    });
    throw new PlaidConsentExpiredError(item.id);
  }

  const accessToken = decryptAccessToken({
    ciphertext: item.accessTokenCiphertext,
    keyId: item.accessTokenKeyId,
  });

  const client = getPlaidClient();
  const balanceMap = await fetchBalancesByPlaidAccountId(client, accessToken);

  let snapshotCount = 0;
  for (const account of item.accounts) {
    const b = balanceMap.get(account.plaidAccountId);
    if (!b) continue;
    await prisma.$transaction([
      prisma.balanceSnapshot.create({
        data: {
          accountId: account.id,
          current: b.current,
          available: b.available ?? null,
          currency: b.currency,
          source: 'PLAID_AISP',
        },
      }),
      prisma.account.update({
        where: { id: account.id },
        data: {
          currentBalance: b.current,
          availableBalance: b.available ?? null,
          asOf: new Date(),
        },
      }),
    ]);
    snapshotCount++;
  }

  await prisma.plaidItem.update({
    where: { id: item.id },
    data: {
      lastRefreshAt: new Date(),
      status: daysUntilExpiry <= CONSENT_EXPIRY_WARNING_DAYS ? 'CONSENT_EXPIRING' : 'HEALTHY',
    },
  });

  return { snapshotCount, consentExpiringSoon: daysUntilExpiry <= CONSENT_EXPIRY_WARNING_DAYS };
}

interface BalanceDto {
  current: number;
  available: number | null;
  currency: string;
}

async function fetchBalancesByPlaidAccountId(
  client: ReturnType<typeof getPlaidClient>,
  accessToken: string,
): Promise<Map<string, BalanceDto>> {
  // TODO: real call
  //   const resp = await client.accountsBalanceGet({ access_token: accessToken });
  //   const out = new Map<string, BalanceDto>();
  //   for (const a of resp.data.accounts) {
  //     out.set(a.account_id, {
  //       current:   a.balances.current   ?? 0,
  //       available: a.balances.available ?? null,
  //       currency:  a.balances.iso_currency_code ?? 'GBP',
  //     });
  //   }
  //   return out;
  return new Map();
}
