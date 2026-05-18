# BankMesh

Multi-bank Open Banking aggregator with policy-driven cash orchestration.

Connect HSBC, Wise, Revolut, Mercury via Plaid AISP. Define policy rules ("keep £80k min at HSBC", "sweep surplus into MMF", "FX-rebalance when EUR > €100k"). BankMesh watches the mesh, proposes sweeps when policy fires, runs them through SCA where PSD2 requires it, and writes everything to an auditable ledger.

Built as a demo for the Round Treasury Founding Product Engineer role.
Stack matches the JD: **Next.js · TypeScript · Prisma · PostgreSQL · Temporal · Inngest** + **Plaid** (AISP + PISP).

---

## How the pieces fit

```
                    ┌──── Plaid Link (browser SDK) ────┐
                    ▼                                  │
        POST /api/accounts/link                        │
        exchange public_token → encrypted              │
        access_token in PlaidItem                      │
                    │                                  │
                    ▼                                  │
        ┌────────────────────────┐                     │
        │  Postgres (Prisma)     │                     │
        │  • PlaidItem (enc)     │                     │
        │  • Account             │                     │
        │  • BalanceSnapshot     │                     │
        │  • Policy (versioned)  │                     │
        │  • Sweep + SweepEvent  │                     │
        └───────────┬────────────┘                     │
                    │                                  │
        ┌───────────┴─────────────────┐                │
        │                             │                │
        ▼                             ▼                │
  Inngest                       Inngest                │
  /5min balance-refresh         /5min policy-eval      │
  → starts                      → POST /api/sweeps     │
  balanceRefreshWorkflow        → starts sweepWorkflow │
        │                             │                │
        ▼                             ▼                │
  Temporal Worker             Temporal Worker          │
  AISP calls                  PROPOSED → APPROVAL?     │
  → BalanceSnapshot           → SCA? → EXECUTING       │
                              → COMPLETED              │
                                     ▲                 │
                                     │                 │
                          POST /api/sweeps/[id]/approve
                          POST /api/webhooks/plaid     ──── (Plaid SCA decision)
```

**The split that matters:**

- **Inngest** is the scheduler — every 5 minutes, "what do we need to look at?"
- **Temporal** is the executor — the durable state machines for refresh and for each sweep, surviving worker restarts and pausing on signals.
- **The policy evaluator is a pure function** — `evaluatePolicy(policy, accounts)`. The same code powers `/policies/[id]/evaluate` (dry-run preview) and the Inngest auto-evaluator (actual proposal). No drift between simulation and execution.

---

## What's in the box

| File | What it does |
|---|---|
| `prisma/schema.prisma` | Encrypted Plaid tokens, append-only `BalanceSnapshot`, versioned `Policy`, typed `Sweep` state machine. |
| `src/lib/crypto.ts` | AES-256-GCM at-rest encryption for Plaid access tokens with KMS-style key id. |
| `src/lib/plaid.ts` | Plaid SDK singleton with env-driven URL + auth. |
| `src/policy/types.ts` | Policy DSL — Zod discriminated union over three rule kinds. |
| `src/policy/evaluator.ts` | **Pure** policy evaluator. `(policy, accounts) → ProposedSweep[]`. |
| `src/temporal/workflows/sweep.ts` | Sweep state machine with two signal pauses (approval, SCA). |
| `src/temporal/workflows/balance-refresh.ts` | Scheduled AISP aggregation with consent-expiry detection. |
| `src/temporal/activities/plaid-aisp.ts` | Balance fetching + 90-day consent lifecycle. |
| `src/temporal/activities/plaid-pisp.ts` | Payment initiation with deterministic idempotency keys + heartbeated polling. |
| `src/app/api/accounts/link/route.ts` | `POST` — exchange Plaid public_token, encrypt & store. |
| `src/app/api/accounts/route.ts` | `GET` — full mesh view. |
| `src/app/api/policies/route.ts` | `POST` — create a new policy version (non-destructive edit). |
| `src/app/api/policies/[id]/evaluate/route.ts` | `POST` — dry-run a policy. |
| `src/app/api/sweeps/route.ts` | `POST` — propose a sweep, start workflow. |
| `src/app/api/sweeps/[id]/approve/route.ts` | `POST` — deliver approval decision. |
| `src/app/api/webhooks/plaid/route.ts` | Plaid webhook with HMAC signature verification, signals workflows on SCA decisions. |
| `src/inngest/functions.ts` | 5-min `balance-refresh` + `policy-evaluator`. |

---

## Design choices worth flagging

### 1. Access tokens encrypted at rest (AES-256-GCM)

A Plaid access_token is the keys to a customer's bank for 90 days. Encrypted with AES-256-GCM, stored as `iv || ciphertext || authTag` base64 in `PlaidItem.accessTokenCiphertext`, with `keyId` for KMS-style rotation. GCM not CBC because authenticated encryption stops ciphertext tampering — a corrupted blob can't silently decrypt to garbage and trigger a wave of Plaid 401s.

### 2. Policies are versioned, not edited in place

Editing a policy creates a new row with `parentPolicyId` pointing back, marks the new version `isActive=true`, and the old one `isActive=false`. Every Sweep stores both `policyId` and `policyVersion`, so when the CFO asks "why did we move £150k last Friday?", we point at the exact, immutable rule set that authorised it.

### 3. The policy evaluator is a pure function

`evaluatePolicy(policy, accounts) → { proposed, skipped }`. Same function powers:
- `POST /api/policies/[id]/evaluate` — the "preview what this policy would do" button
- The Inngest `policy-evaluator` cron — actual proposal

No risk of drift between simulation and execution. Also trivial to unit-test (which is the first thing I'd add).

### 4. Sweep workflow has two distinct signal pauses

- **Approval signal** (`/sweeps/[id]/approve` → workflow): 30-minute SLA. Sweeps are time-sensitive — MMF cut-offs, FX rate freshness — so the SLA is much tighter than PayrollPilot's 4-hour approval window.
- **SCA-completed signal** (Plaid webhook → workflow): 5-minute SLA. PSD2 requires Strong Customer Authentication for cross-bank payments above a threshold. The workflow submits the transfer to Plaid, gets back a challenge_id, then waits for the webhook to signal `AUTHORISED | FAILED | EXPIRED`.

Both pauses are durable — Temporal lets the workflow stay parked for the full SLA without holding a thread, and the worker can restart underneath.

### 5. Webhook idempotency + signature verification

Plaid retries webhooks. We persist `SweepEvent` rows for every webhook received, keyed by challenge id; a re-delivery finds the existing `SCA_DECISION_RECEIVED` row and returns 200 without re-signalling. Signature verification is timing-safe (`crypto.timingSafeEqual`), with a dev-mode permissive fallback so local development against the Plaid sandbox doesn't require a real signing key.

### 6. Consent lifecycle is tracked, not assumed

PSD2 caps AIS consent at 90 days. `PlaidItem.consentExpiresAt` is a real column; the balance-refresh workflow surfaces items within 7 days of expiry as `CONSENT_EXPIRING` and Slacks the operator. Without this, consents die silently — you find out when the next AISP call returns `ITEM_LOGIN_REQUIRED`.

### 7. Deterministic transfer idempotency keys

Same pattern as PayrollPilot: `sha256("sweep:<sweepId>:<amountMinorUnits>")` → 32-char key sent as `idempotency_key` to Plaid. Same sweep retried by Temporal → same key → Plaid-side dedup. A modified amount = different key, forcing it to be a separate transfer rather than a silent overwrite.

---

## Quickstart

```bash
npm install

# Infra (separate terminals)
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
temporal server start-dev
npx inngest-cli@latest dev

# Configure — at minimum set ACCESS_TOKEN_AES_KEY (32 bytes base64):
#   openssl rand -base64 32
cp .env.example .env.local

# DB
npm run db:migrate
npm run db:seed

# Runtime (separate terminals)
npm run worker
npm run dev
```

Exercise the API:

```bash
# See the mesh
curl http://localhost:3000/api/accounts

# Create / edit a policy (creates v2 if 'weekly-sweep' exists)
curl -X POST http://localhost:3000/api/policies \
  -H "content-type: application/json" \
  -d '{
    "name":"weekly-sweep",
    "createdBy":"u_treasurer",
    "rules":{"rules":[
      {"kind":"minimum_balance","accountSelector":{"bankName":"HSBC"},"minimum":80000},
      {"kind":"sweep_surplus","source":{"currency":"GBP","minimumBuffer":80000},
       "target":{"accountType":"MMF"},"triggerAboveSurplus":5000,
       "approvalRequiredAbove":50000,"scaRequiredAbove":30000}
    ]}
  }'

# Preview what the policy would propose right now
curl -X POST http://localhost:3000/api/policies/<id>/evaluate

# Manual sweep
curl -X POST http://localhost:3000/api/sweeps \
  -H "content-type: application/json" \
  -d '{
    "fromAccountId":"<hsbc-checking-id>",
    "toAccountId":"<hsbc-mmf-id>",
    "amount":68000,
    "currency":"GBP",
    "reason":"Q1 surplus"
  }'

# If it pauses for approval:
curl -X POST http://localhost:3000/api/sweeps/<id>/approve \
  -H "content-type: application/json" \
  -d '{"decision":"APPROVED","approverId":"u_treasurer"}'

# Plaid SCA decision (in production, comes from Plaid; replay manually here):
curl -X POST http://localhost:3000/api/webhooks/plaid \
  -H "content-type: application/json" \
  -H "plaid-verification: <hmac>" \
  -d '{
    "webhook_type":"AUTH",
    "webhook_code":"AUTHORIZATION_DECISION",
    "authorization":{"id":"auth_1","decision":"approved","challenge_id":"sca_xxx"}
  }'
```

---

## What's not in this Project

- **Auth + multi-tenancy.** Routes take `userId` from the body; production wraps with `withAuth(orgId)` and rows get an `organizationId` column.
- **Real Plaid calls.** `accountsBalanceGet`, `transferCreate`, etc. are stubbed; shapes match the SDK. Drop in real credentials and remove the stubs.
- **KMS-managed encryption keys.** Env-based `ACCESS_TOKEN_AES_KEY` for dev; production reads from AWS KMS / Vault via the `keyId` indirection already in the schema.
- **Yield accrual job.** Schema has `YieldAccrual` table; the daily activity that fills it isn't implemented.
- **Tests.** Pure `evaluatePolicy` is the highest-leverage test target; Temporal `TestWorkflowEnvironment` for the sweep state machine; webhook signature verification.
- **Observability.** OpenTelemetry across Inngest → Temporal → activity; Datadog metrics on sweep-state-duration percentiles.

---

Built by Sameer M · 2026 · 
