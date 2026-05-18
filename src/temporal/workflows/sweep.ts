import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  log,
} from '@temporalio/workflow';
import type * as activities from '../activities';

/**
 * Sweep execution workflow.
 *
 *   PROPOSED → [APPROVAL?] → [SCA?] → EXECUTING → COMPLETED
 *                                              ↘ FAILED
 *
 * Two pause points, both signal-driven:
 *
 *  1. Human approval. Sweep above policy threshold? Wait for the
 *     `/sweeps/[id]/approve` endpoint to send an `approvalSignal`.
 *     SLA is 30 minutes — sweeps are time-sensitive (FX moves, MMF
 *     cut-offs), much shorter than payroll's 4h.
 *
 *  2. PSD2 Strong Customer Authentication. Plaid Payment Initiation
 *     for amounts above the bank's exemption threshold (typically
 *     £30 for personal, much higher for business) requires SCA. We
 *     submit the payment, get a challenge id, wait for the bank's
 *     webhook to confirm via `scaCompletedSignal`.
 *
 * Both pause states are durable — the worker can restart and the
 * workflow picks back up where it was.
 */

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '1s',
    maximumInterval: '1m',
    backoffCoefficient: 2,
    maximumAttempts: 3,
    // Non-retryable: bad consent or insufficient funds get surfaced
    // immediately, not retried into a guaranteed failure.
    nonRetryableErrorTypes: [
      'PlaidConsentExpiredError',
      'InsufficientFundsError',
      'AccountFrozenError',
    ],
  },
});

export interface ApprovalSignalPayload {
  decision: 'APPROVED' | 'REJECTED';
  approverId: string;
  reason?: string;
}
export const approvalSignal = defineSignal<[ApprovalSignalPayload]>('approval');

export interface ScaCompletedSignalPayload {
  scaChallengeId: string;
  status: 'AUTHORISED' | 'FAILED' | 'EXPIRED';
}
export const scaCompletedSignal = defineSignal<[ScaCompletedSignalPayload]>('scaCompleted');

export interface SweepWorkflowInput {
  sweepId: string;
}

export interface SweepWorkflowResult {
  status: 'COMPLETED' | 'REJECTED' | 'FAILED' | 'CANCELLED';
  plaidTransferId?: string;
}

const APPROVAL_SLA_MS = 30 * 60 * 1000;    // 30 minutes
const SCA_SLA_MS = 5 * 60 * 1000;          // 5 minutes — most banks set this themselves

export async function sweepWorkflow(input: SweepWorkflowInput): Promise<SweepWorkflowResult> {
  const { sweepId } = input;
  log.info('sweep.start', { sweepId });

  let approval: ApprovalSignalPayload | undefined;
  let scaResult: ScaCompletedSignalPayload | undefined;

  setHandler(approvalSignal, (p) => { approval = p; });
  setHandler(scaCompletedSignal, (p) => { scaResult = p; });

  // 1. Load + recompute risk classification (in case balances moved
  //    between policy evaluation and workflow start).
  const decision = await acts.classifySweep({ sweepId });
  await acts.recordSweepEvent({
    sweepId,
    eventType: 'CLASSIFIED',
    payload: {
      approvalRequired: decision.approvalRequired,
      scaRequired: decision.scaRequired,
    },
  });

  // 2. Approval gate (if required)
  if (decision.approvalRequired) {
    await acts.setSweepState({ sweepId, state: 'PENDING_APPROVAL' });
    const got = await condition(() => approval !== undefined, APPROVAL_SLA_MS);
    if (!got) {
      await acts.setSweepState({ sweepId, state: 'CANCELLED' });
      await acts.recordSweepEvent({ sweepId, eventType: 'APPROVAL_TIMED_OUT', payload: {} });
      return { status: 'CANCELLED' };
    }
    if (approval!.decision === 'REJECTED') {
      await acts.recordSweepDecision({
        sweepId,
        decision: 'REJECTED',
        approverId: approval!.approverId,
        reason: approval!.reason,
      });
      return { status: 'REJECTED' };
    }
    await acts.recordSweepDecision({
      sweepId,
      decision: 'APPROVED',
      approverId: approval!.approverId,
    });
  }

  // 3. Initiate payment via Plaid PISP
  await acts.setSweepState({
    sweepId,
    state: decision.scaRequired ? 'SCA_REQUIRED' : 'EXECUTING',
  });

  const submission = await acts.submitPlaidTransfer({ sweepId });
  await acts.recordSweepEvent({
    sweepId,
    eventType: 'TRANSFER_SUBMITTED',
    payload: { plaidTransferId: submission.plaidTransferId, scaChallengeId: submission.scaChallengeId },
  });

  // 4. SCA challenge (PSD2)
  if (decision.scaRequired) {
    const got = await condition(() => scaResult !== undefined, SCA_SLA_MS);
    if (!got) {
      await acts.failSweep({ sweepId, reason: 'SCA challenge timed out' });
      return { status: 'FAILED' };
    }
    if (scaResult!.status !== 'AUTHORISED') {
      await acts.failSweep({ sweepId, reason: `SCA ${scaResult!.status.toLowerCase()}` });
      return { status: 'FAILED' };
    }
    await acts.markScaCompleted({ sweepId });
  }

  // 5. Wait for Plaid to confirm settlement (driven by webhook → activity)
  const settled = await acts.awaitTransferSettlement({
    sweepId,
    plaidTransferId: submission.plaidTransferId,
  });

  if (settled.status !== 'SETTLED') {
    await acts.failSweep({ sweepId, reason: `transfer ${settled.status}` });
    return { status: 'FAILED' };
  }

  // 6. Update destination balance + notify
  await acts.applySweepToLedger({ sweepId });
  await acts.notifySweepCompleted({ sweepId });

  await acts.setSweepState({ sweepId, state: 'COMPLETED' });
  log.info('sweep.completed', { sweepId, plaidTransferId: submission.plaidTransferId });

  return { status: 'COMPLETED', plaidTransferId: submission.plaidTransferId };
}
