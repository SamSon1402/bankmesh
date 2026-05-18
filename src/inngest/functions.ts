import { inngest } from './client';
import { prisma } from '../lib/prisma';
import { getTemporalClient, TASK_QUEUE } from '../lib/temporal-client';
import { PolicyRules } from '../policy/types';
import { evaluatePolicy } from '../policy/evaluator';

/**
 * Two Inngest functions:
 *
 *  1. balanceRefresh   — every 5m, kicks off the balanceRefreshWorkflow
 *                        in Temporal. We could call AISP directly from
 *                        here, but routing through Temporal gives us
 *                        retry + visibility + a single place to add
 *                        rate-limit guards.
 *
 *  2. policyEvaluator  — every 5m, walks active policies, evaluates
 *                        each against current balances, and POSTs
 *                        proposed sweeps. Deduped by Sweep table's
 *                        natural state: if a PROPOSED/PENDING sweep
 *                        already exists for (from, to, amount), skip.
 */

export const balanceRefresh = inngest.createFunction(
  { id: 'balance-refresh' },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    return step.run('start-workflow', async () => {
      const client = await getTemporalClient();
      const handle = await client.workflow.start('balanceRefreshWorkflow', {
        args: [],
        taskQueue: TASK_QUEUE,
        // Reusing the same workflowId across runs would conflict;
        // use a time-bucketed id so consecutive runs don't collide
        // and Temporal still rejects accidental dupes within a bucket.
        workflowId: `balance-refresh-${Math.floor(Date.now() / (5 * 60 * 1000))}`,
      });
      return { workflowId: handle.workflowId };
    });
  }
);

export const policyEvaluator = inngest.createFunction(
  { id: 'policy-evaluator' },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const policies = await step.run('load-active-policies', async () => {
      const list = await prisma.policy.findMany({ where: { isActive: true } });
      return list.map((p) => ({
        id: p.id,
        version: p.version,
        rules: PolicyRules.parse(p.rules),
      }));
    });

    const accounts = await step.run('load-accounts', async () => prisma.account.findMany());

    let proposed = 0;
    for (const policy of policies) {
      const result = evaluatePolicy(policy.rules, accounts);
      for (const p of result.proposed) {
        await step.run(`propose-${policy.id}-${p.fromAccountId}-${p.toAccountId}`, async () => {
          // Dedupe: skip if a non-terminal sweep already exists for this triplet.
          const existing = await prisma.sweep.findFirst({
            where: {
              fromAccountId: p.fromAccountId,
              toAccountId: p.toAccountId,
              amount: p.amount,
              state: { in: ['PROPOSED', 'PENDING_APPROVAL', 'SCA_REQUIRED', 'EXECUTING'] },
            },
          });
          if (existing) return { skipped: existing.id };

          const sweep = await prisma.sweep.create({
            data: {
              policyId: policy.id,
              policyVersion: policy.version,
              fromAccountId: p.fromAccountId,
              toAccountId: p.toAccountId,
              amount: p.amount,
              currency: p.currency,
              reason: p.reason,
              scaRequired: p.scaRequired,
            },
          });
          const client = await getTemporalClient();
          await client.workflow.start('sweepWorkflow', {
            args: [{ sweepId: sweep.id }],
            taskQueue: TASK_QUEUE,
            workflowId: `sweep-${sweep.id}`,
          });
          proposed++;
          return { sweepId: sweep.id };
        });
      }
    }

    return { proposed };
  }
);
