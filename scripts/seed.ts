import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // Mock PlaidItem (no real token — for dev only)
  const hsbcItem = await prisma.plaidItem.create({
    data: {
      plaidItemId: 'item_hsbc_demo',
      institutionId: 'ins_117',
      institutionName: 'HSBC',
      accessTokenCiphertext: 'DEV-ONLY-NOT-REAL',
      accessTokenKeyId: 'local-dev-key',
      consentExpiresAt: new Date(Date.now() + 88 * 86_400_000),
    },
  });
  await prisma.account.createMany({
    data: [
      { plaidItemId: hsbcItem.id, plaidAccountId: 'acc_h1', bankName: 'HSBC',    accountName: 'Business Current', accountType: 'CHECKING', currency: 'GBP', currentBalance: 148000, minimumBalance: 80000, sweepEligible: true },
      { plaidItemId: hsbcItem.id, plaidAccountId: 'acc_h2', bankName: 'HSBC',    accountName: 'MMF Sweep',        accountType: 'MMF',      currency: 'GBP', currentBalance: 280000 },
    ],
  });

  const wiseItem = await prisma.plaidItem.create({
    data: {
      plaidItemId: 'item_wise_demo',
      institutionId: 'ins_wise',
      institutionName: 'Wise',
      accessTokenCiphertext: 'DEV-ONLY-NOT-REAL',
      accessTokenKeyId: 'local-dev-key',
      consentExpiresAt: new Date(Date.now() + 60 * 86_400_000),
    },
  });
  await prisma.account.create({
    data: { plaidItemId: wiseItem.id, plaidAccountId: 'acc_w1', bankName: 'Wise', accountName: 'EUR FX Hub', accountType: 'FX_HOLDING', currency: 'EUR', currentBalance: 72400, minimumBalance: 40000, sweepEligible: true },
  });

  const revolutItem = await prisma.plaidItem.create({
    data: {
      plaidItemId: 'item_revolut_demo',
      institutionId: 'ins_revolut',
      institutionName: 'Revolut',
      accessTokenCiphertext: 'DEV-ONLY-NOT-REAL',
      accessTokenKeyId: 'local-dev-key',
      consentExpiresAt: new Date(Date.now() + 75 * 86_400_000),
    },
  });
  await prisma.account.create({
    data: { plaidItemId: revolutItem.id, plaidAccountId: 'acc_r1', bankName: 'Revolut', accountName: 'Cards Pool', accountType: 'CHECKING', currency: 'GBP', currentBalance: 62000, minimumBalance: 40000, sweepEligible: true },
  });

  // A starter policy
  await prisma.policy.create({
    data: {
      name: 'weekly-sweep',
      version: 1,
      isActive: true,
      createdBy: 'seed',
      description: 'Sweep GBP surplus over £80k into MMF; approval over £50k',
      rules: {
        rules: [
          { kind: 'minimum_balance', accountSelector: { bankName: 'HSBC' }, minimum: 80000 },
          { kind: 'sweep_surplus',
            source: { currency: 'GBP', minimumBuffer: 80000 },
            target: { accountType: 'MMF' },
            triggerAboveSurplus: 5000,
            approvalRequiredAbove: 50000,
            scaRequiredAbove: 30000,
          },
        ],
      } as never,
    },
  });

  console.log('seeded HSBC + Wise + Revolut accounts and weekly-sweep policy v1');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
