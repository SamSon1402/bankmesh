import { serve } from 'inngest/next';
import { inngest } from '@/inngest/client';
import { balanceRefresh, policyEvaluator } from '@/inngest/functions';

export const runtime = 'nodejs';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [balanceRefresh, policyEvaluator],
});
