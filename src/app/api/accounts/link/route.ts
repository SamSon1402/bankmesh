import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getPlaidClient } from '@/lib/plaid';
import { encryptAccessToken } from '@/lib/crypto';

/**
 * POST /api/accounts/link
 *
 * The end of the Plaid Link flow. The browser SDK gives the user a
 * public_token; we exchange it for the long-lived access_token, fetch
 * accounts, encrypt the token and persist everything.
 *
 *   curl -X POST http://localhost:3000/api/accounts/link \
 *     -H "content-type: application/json" \
 *     -d '{"publicToken":"public-sandbox-xxx","userId":"u_demo"}'
 *
 * Security note: the access_token is plaintext for ~1ms inside this
 * handler, then never again — encrypted before insert, decrypted only
 * inside Temporal activities that need it.
 */

export const runtime = 'nodejs';

const Body = z.object({
  publicToken: z.string().min(1),
  userId: z.string().min(1),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 });
  }
  const { publicToken } = parsed.data;

  const plaid = getPlaidClient();

  // TODO: real exchange
  //   const exchange = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  //   const accessToken = exchange.data.access_token;
  //   const itemId = exchange.data.item_id;
  //   const item = await plaid.itemGet({ access_token: accessToken });
  //   const accounts = await plaid.accountsGet({ access_token: accessToken });
  const exchanged = await exchangeStub(publicToken);

  const encrypted = encryptAccessToken(exchanged.accessToken);

  // Persist the item + accounts in one transaction.
  const created = await prisma.$transaction(async (tx) => {
    const item = await tx.plaidItem.create({
      data: {
        plaidItemId: exchanged.itemId,
        institutionId: exchanged.institutionId,
        institutionName: exchanged.institutionName,
        accessTokenCiphertext: encrypted.ciphertext,
        accessTokenKeyId: encrypted.keyId,
        consentExpiresAt: new Date(Date.now() + 90 * 86_400_000), // PSD2 max 90d
      },
    });
    await tx.account.createMany({
      data: exchanged.accounts.map((a) => ({
        plaidItemId: item.id,
        plaidAccountId: a.plaidAccountId,
        bankName: a.bankName,
        accountName: a.name,
        accountType: a.type,
        currency: a.currency,
      })),
    });
    return item;
  });

  return NextResponse.json({
    plaidItemId: created.id,
    institution: created.institutionName,
    consentExpiresAt: created.consentExpiresAt,
  }, { status: 201 });
}

async function exchangeStub(publicToken: string): Promise<{
  accessToken: string;
  itemId: string;
  institutionId: string;
  institutionName: string;
  accounts: Array<{
    plaidAccountId: string;
    name: string;
    bankName: string;
    type: 'CHECKING' | 'SAVINGS' | 'MMF' | 'FX_HOLDING';
    currency: string;
  }>;
}> {
  return {
    accessToken: `access-${publicToken}`,
    itemId: `item_${Date.now()}`,
    institutionId: 'ins_117',
    institutionName: 'HSBC',
    accounts: [
      { plaidAccountId: 'acc_h1', name: 'Business Current', bankName: 'HSBC', type: 'CHECKING', currency: 'GBP' },
    ],
  };
}
