import { proxyActivities, log } from '@temporalio/workflow';
import type * as activities from '../activities';

/**
 * Balance refresh workflow.
 *
 * Runs every N minutes (kicked off by Inngest). For each healthy
 * PlaidItem we call AISP, write a BalanceSnapshot, update the
 * Account denormalised values, and detect any consent that's about
 * to expire so we can prompt re-auth before it dies.
 *
 * Kept as a workflow rather than a one-shot job so we get:
 *   - automatic retries with backoff on transient Plaid 5xxs
 *   - visibility in the Temporal UI for ops debugging
 *   - one place where consent-renewal nags get triggered
 */

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '2s',
    maximumInterval: '5m',
    backoffCoefficient: 2,
    maximumAttempts: 4,
    nonRetryableErrorTypes: ['PlaidConsentExpiredError'],
  },
});

export interface BalanceRefreshResult {
  itemsRefreshed: number;
  snapshotCount: number;
  expiringSoon: number;
}

export async function balanceRefreshWorkflow(): Promise<BalanceRefreshResult> {
  log.info('balance_refresh.start');

  const items = await acts.listHealthyPlaidItems();
  let snapshotCount = 0;
  let expiringSoon = 0;

  // Sequential per-item — keeps us well inside Plaid's rate limit.
  // Parallel would need a token-bucket activity guard.
  for (const item of items) {
    try {
      const result = await acts.refreshItemBalances({ plaidItemId: item.id });
      snapshotCount += result.snapshotCount;
      if (result.consentExpiringSoon) {
        expiringSoon++;
        await acts.notifyConsentExpiring({ plaidItemId: item.id });
      }
    } catch (err) {
      // Per-item failures should not poison the whole refresh batch.
      log.warn('balance_refresh.item_failed', { plaidItemId: item.id, error: (err as Error).message });
    }
  }

  log.info('balance_refresh.done', { itemsRefreshed: items.length, snapshotCount, expiringSoon });
  return { itemsRefreshed: items.length, snapshotCount, expiringSoon };
}
