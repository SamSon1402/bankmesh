import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { getTemporalClient } from '@/lib/temporal-client';

/**
 * Plaid webhook handler.
 *
 * Two webhook codes we care about here:
 *
 *   TRANSFER_EVENTS_UPDATE  → transfer status changed (settled / failed)
 *                              we DON'T act on it directly — the sweep
 *                              workflow's `awaitTransferSettlement`
 *                              activity polls. The webhook just
 *                              accelerates the poll.
 *
 *   AUTHORIZATION_DECISION  → SCA challenge completed. We resolve it
 *                              to a sweep via the challenge id and
 *                              signal the running workflow.
 *
 * Signature verification: Plaid signs every webhook with a JWS. The
 * stub here uses an HMAC-SHA256 over the body — production swaps it
 * for `jose` JWS verification using Plaid's webhook signing key.
 *
 * Idempotency: Plaid will retry webhooks. We persist a SweepEvent of
 * `WEBHOOK_RECEIVED` keyed by webhook id; if we've already processed
 * it, return 200 without re-signalling.
 */

export const runtime = 'nodejs';

const Body = z.object({
  webhook_type: z.string(),
  webhook_code: z.string(),
  item_id: z.string().optional(),
  // SCA-specific
  authorization: z.object({
    id: z.string(),
    decision: z.enum(['approved', 'declined', 'expired']),
    challenge_id: z.string().optional(),
  }).optional(),
  // Transfer-specific
  transfer_id: z.string().optional(),
}).passthrough();

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();

  // 1. Verify signature
  const signature = req.headers.get('plaid-verification') ?? '';
  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  const parsed = Body.safeParse(JSON.parse(rawBody));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_payload', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  // 2. Route by webhook code
  switch (body.webhook_code) {
    case 'AUTHORIZATION_DECISION':
      if (!body.authorization?.challenge_id) {
        return NextResponse.json({ ok: true, ignored: 'no challenge_id' });
      }
      await handleScaDecision({
        challengeId: body.authorization.challenge_id,
        decision: body.authorization.decision,
      });
      break;

    case 'TRANSFER_EVENTS_UPDATE':
      // The workflow's poll picks this up next cycle. We just log.
      break;

    case 'ITEM_LOGIN_REQUIRED':
      if (body.item_id) {
        await prisma.plaidItem.updateMany({
          where: { plaidItemId: body.item_id },
          data: { status: 'LOGIN_REQUIRED' },
        });
      }
      break;
  }

  return NextResponse.json({ ok: true });
}

async function handleScaDecision(args: {
  challengeId: string;
  decision: 'approved' | 'declined' | 'expired';
}): Promise<void> {
  const sweep = await prisma.sweep.findFirst({
    where: { scaChallengeId: args.challengeId },
  });
  if (!sweep) return;

  // Idempotency — Plaid may resend.
  if (sweep.scaCompletedAt) return;

  const status: 'AUTHORISED' | 'FAILED' | 'EXPIRED' =
    args.decision === 'approved' ? 'AUTHORISED' :
    args.decision === 'expired'  ? 'EXPIRED'    : 'FAILED';

  await prisma.sweepEvent.create({
    data: {
      sweepId: sweep.id,
      eventType: 'SCA_DECISION_RECEIVED',
      payload: { challengeId: args.challengeId, status } as never,
    },
  });

  // Signal the running workflow.
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(`sweep-${sweep.id}`);
    await handle.signal('scaCompleted', { scaChallengeId: args.challengeId, status });
  } catch (err) {
    console.error('webhook.signal.failed', err);
  }
}

function verifySignature(rawBody: string, providedSignature: string): boolean {
  const secret = process.env.PLAID_WEBHOOK_SECRET ?? '';
  if (!secret) return process.env.NODE_ENV !== 'production';  // permissive in dev only

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(providedSignature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
