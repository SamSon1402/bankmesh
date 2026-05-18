import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/accounts
 *
 * The mesh view — every connected account with its current balance,
 * minimum, and surplus computation. Used by the cockpit UI to render
 * the bank-card grid.
 *
 *   curl http://localhost:3000/api/accounts
 */

export const runtime = 'nodejs';

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const accounts = await prisma.account.findMany({
    include: { plaidItem: { select: { status: true, consentExpiresAt: true } } },
    orderBy: [{ currency: 'asc' }, { bankName: 'asc' }],
  });

  return NextResponse.json({
    accounts: accounts.map((a) => {
      const current = Number(a.currentBalance);
      const minimum = Number(a.minimumBalance);
      return {
        id: a.id,
        bankName: a.bankName,
        accountName: a.accountName,
        accountType: a.accountType,
        currency: a.currency,
        currentBalance: current,
        availableBalance: a.availableBalance ? Number(a.availableBalance) : null,
        minimumBalance: minimum,
        surplus: Math.max(0, current - minimum),
        asOf: a.asOf,
        sweepEligible: a.sweepEligible,
        consentStatus: a.plaidItem.status,
        consentExpiresAt: a.plaidItem.consentExpiresAt,
      };
    }),
  });
}
