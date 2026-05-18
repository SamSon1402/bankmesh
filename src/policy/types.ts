import { z } from 'zod';

/**
 * Policy DSL.
 *
 * A policy is a named, versioned set of rules. Each rule is one of
 * three kinds — same shape as the in-product visual policy builder
 * would write to / read from.
 *
 *   - minimum_balance:  per account, never let it drop below X
 *   - sweep_surplus:    move >X above minimum into a target account
 *   - fx_rebalance:     when balance > X in non-base currency, swap
 *
 * Why a typed DSL and not "code"? Because the customer's CFO wants to
 * read it, the auditor wants to diff it, and we want every sweep to
 * be able to point at the exact rule that authorised it. A schema
 * gives us all three for free.
 */

const Currency = z.string().regex(/^[A-Z]{3}$/);

const RuleMinimumBalance = z.object({
  kind: z.literal('minimum_balance'),
  accountSelector: z.object({
    bankName: z.string().optional(),
    accountType: z.enum(['CHECKING', 'SAVINGS', 'MMF', 'FX_HOLDING']).optional(),
    currency: Currency.optional(),
  }),
  minimum: z.number().nonnegative(),
});

const RuleSweepSurplus = z.object({
  kind: z.literal('sweep_surplus'),
  // Where the surplus comes from:
  source: z.object({
    bankName: z.string().optional(),
    currency: Currency,
    minimumBuffer: z.number().nonnegative(), // never leave less than this
  }),
  // Where it goes:
  target: z.object({
    accountType: z.enum(['MMF', 'SAVINGS']),
    bankName: z.string().optional(),
  }),
  // Only sweep amounts above this threshold (avoid tiny noise transfers).
  triggerAboveSurplus: z.number().nonnegative().default(5000),
  // Sweeps over this amount need an approval signal before execution.
  approvalRequiredAbove: z.number().positive().optional(),
  // SCA always required for cross-bank moves over this amount, per PSD2.
  scaRequiredAbove: z.number().positive().default(30000),
});

const RuleFxRebalance = z.object({
  kind: z.literal('fx_rebalance'),
  fromCurrency: Currency,
  toCurrency: Currency,
  triggerWhenBalanceAbove: z.number().positive(),
  buffer: z.number().nonnegative().default(0),
  maxAgeOfRateSeconds: z.number().int().positive().default(120),
});

export const Rule = z.discriminatedUnion('kind', [
  RuleMinimumBalance,
  RuleSweepSurplus,
  RuleFxRebalance,
]);
export type Rule = z.infer<typeof Rule>;

export const PolicyRules = z.object({
  rules: z.array(Rule).min(1),
});
export type PolicyRules = z.infer<typeof PolicyRules>;
