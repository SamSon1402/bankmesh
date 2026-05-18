import type { Account } from '@prisma/client';
import type { PolicyRules, Rule } from './types';

/**
 * Policy evaluator.
 *
 * Pure function: takes the current balance snapshot of all accounts +
 * a policy, returns a list of PROPOSED sweeps. Does not touch the DB,
 * does not call any external service, has no side effects.
 *
 * Keeping the evaluator pure means:
 *   - It's trivial to unit-test (which we'd do exhaustively in CI).
 *   - The same function powers "preview what would happen" (POST .../evaluate)
 *     AND the actual sweep workflow — no risk of drift between
 *     simulation and execution.
 *   - Idempotent: same inputs → same proposed sweeps. The Inngest
 *     scheduler can call this every 5 minutes and the OperatorActivity
 *     downstream just dedupes by (fromAccount, toAccount, amount).
 */

export interface ProposedSweep {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  currency: string;
  reason: string;
  ruleIndex: number;                  // for traceability back to policy
  approvalRequired: boolean;
  scaRequired: boolean;
}

export interface EvaluationResult {
  proposed: ProposedSweep[];
  // Rules that triggered but were rejected (no eligible target,
  // surplus below trigger, etc.) — surfaced for "why isn't this
  // policy doing anything" debugging.
  skipped: { ruleIndex: number; reason: string }[];
}

export function evaluatePolicy(
  policy: PolicyRules,
  accounts: Account[]
): EvaluationResult {
  const proposed: ProposedSweep[] = [];
  const skipped: { ruleIndex: number; reason: string }[] = [];

  policy.rules.forEach((rule, ruleIndex) => {
    switch (rule.kind) {
      case 'minimum_balance':
        // Informational rule — no sweep proposed by itself. The other
        // rules consult it via `minimumBalance` on the Account row,
        // which the policy syncer keeps up to date.
        break;

      case 'sweep_surplus': {
        const result = evaluateSweepSurplus(rule, accounts, ruleIndex);
        if (result.proposed) proposed.push(result.proposed);
        if (result.skipped)  skipped.push(result.skipped);
        break;
      }

      case 'fx_rebalance': {
        const result = evaluateFxRebalance(rule, accounts, ruleIndex);
        if (result.proposed) proposed.push(result.proposed);
        if (result.skipped)  skipped.push(result.skipped);
        break;
      }
    }
  });

  return { proposed, skipped };
}

// --- per-rule kernels -----------------------------------------------------

function evaluateSweepSurplus(
  rule: Extract<Rule, { kind: 'sweep_surplus' }>,
  accounts: Account[],
  ruleIndex: number,
): { proposed?: ProposedSweep; skipped?: { ruleIndex: number; reason: string } } {
  // Source: highest-surplus account that matches the selector.
  const sources = accounts
    .filter((a) => a.currency === rule.source.currency)
    .filter((a) => !rule.source.bankName || a.bankName === rule.source.bankName)
    .filter((a) => a.sweepEligible);

  if (sources.length === 0) {
    return { skipped: { ruleIndex, reason: 'no eligible source account' } };
  }

  // Pick the source with the largest surplus over (its minimum + the
  // rule's buffer). This naturally rebalances across accounts in the
  // same currency.
  const candidate = sources
    .map((a) => ({
      account: a,
      surplus: Number(a.currentBalance) - Math.max(Number(a.minimumBalance), rule.source.minimumBuffer),
    }))
    .sort((x, y) => y.surplus - x.surplus)[0]!;

  if (candidate.surplus < rule.triggerAboveSurplus) {
    return { skipped: { ruleIndex, reason: `surplus ${candidate.surplus} < trigger ${rule.triggerAboveSurplus}` } };
  }

  // Target: any account of the target type, matching bankName if given.
  const target = accounts.find((a) =>
    a.accountType === rule.target.accountType &&
    a.currency === rule.source.currency &&
    (!rule.target.bankName || a.bankName === rule.target.bankName)
  );
  if (!target) {
    return { skipped: { ruleIndex, reason: 'no eligible target account' } };
  }

  const amount = round2(candidate.surplus);

  return {
    proposed: {
      fromAccountId: candidate.account.id,
      toAccountId: target.id,
      amount,
      currency: candidate.account.currency,
      reason: `surplus sweep per policy rule #${ruleIndex} (${candidate.account.bankName} → ${target.bankName})`,
      ruleIndex,
      approvalRequired:
        rule.approvalRequiredAbove !== undefined && amount > rule.approvalRequiredAbove,
      scaRequired: amount > rule.scaRequiredAbove,
    },
  };
}

function evaluateFxRebalance(
  rule: Extract<Rule, { kind: 'fx_rebalance' }>,
  accounts: Account[],
  ruleIndex: number,
): { proposed?: ProposedSweep; skipped?: { ruleIndex: number; reason: string } } {
  const source = accounts.find((a) => a.currency === rule.fromCurrency && a.sweepEligible);
  const target = accounts.find((a) => a.currency === rule.toCurrency);
  if (!source) return { skipped: { ruleIndex, reason: `no ${rule.fromCurrency} source` } };
  if (!target) return { skipped: { ruleIndex, reason: `no ${rule.toCurrency} target` } };
  if (Number(source.currentBalance) <= rule.triggerWhenBalanceAbove) {
    return { skipped: { ruleIndex, reason: `balance below FX trigger threshold` } };
  }
  const amount = round2(Number(source.currentBalance) - rule.triggerWhenBalanceAbove);
  return {
    proposed: {
      fromAccountId: source.id,
      toAccountId: target.id,
      amount,
      currency: source.currency,
      reason: `FX rebalance ${rule.fromCurrency}→${rule.toCurrency} per policy rule #${ruleIndex}`,
      ruleIndex,
      approvalRequired: amount > 50_000,         // FX always reviewed
      scaRequired: true,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
