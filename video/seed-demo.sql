-- ═══════════════════════════════════════════════════════════════════
-- x402 LLM Gateway — demo dataset for the product pitch video
-- ═══════════════════════════════════════════════════════════════════
--
-- Populates a LOCAL demo database with the shape of traffic a production
-- provider would see: ~1.8k paid requests, ~200 unpaid (402s), confirmed
-- payments with transaction hashes, audit trail, and a notification feed.
--
-- This exists so the dashboard shown in the video renders populated screens.
-- The numbers below are synthetic demo data — they are NOT on-chain evidence.
-- The on-chain evidence in the video comes from `scripts/testnet-journey.sh`
-- and `docs/evidence/testnet-journey.json`.
--
-- Usage (database inside the journey container):
--   docker exec -i x402-journey-pg \
--     psql -U x402 -d x402 -v ON_ERROR_STOP=1 < video/seed-demo.sql
--
-- Idempotent: re-running replaces the demo rows.

\set ON_ERROR_STOP on

BEGIN;

-- ── Clean previous demo rows ────────────────────────────────────────
DELETE FROM "AnalyticsEvent";
DELETE FROM "Payment" WHERE "quoteId" LIKE 'demo-%';
DELETE FROM "AuditLog" WHERE id LIKE 'demo-%' OR details->>'demo' = 'true';
DELETE FROM "Notification" WHERE id LIKE 'demo-%';
DELETE FROM "PayoutProposal";
DELETE FROM "UnderpaymentDebt";

-- ── Provider ────────────────────────────────────────────────────────
UPDATE "Provider"
SET name = 'Nebula AI',
    "webhookUrl" = 'https://api.nebula-ai.dev/hooks/x402',
    "webhookSecret" = 'whsec_demo_5f4c2b8a91ee',
    metadata = '{"demo": "true", "tier": "growth"}'::jsonb,
    "updatedAt" = now()
WHERE id = 'journey-provider';

-- ── Routes ──────────────────────────────────────────────────────────
INSERT INTO "Route" (id, "providerId", path, "upstreamUrl", model, "pricingModel",
                     "flatPrice", "perTokenPrice", "acceptedAssets", "rateLimit", active,
                     "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'journey-provider', '/v1/chat/completions',
   'https://api.openai.com/v1/chat/completions', 'gpt-4o-mini', 'flat',
   '50000', NULL, ARRAY['USDC'], 30, true, now(), now()),
  (gen_random_uuid(), 'journey-provider', '/v1/chat/completions',
   'https://api.anthropic.com/v1/messages', 'claude-3-5-sonnet', 'flat',
   '250000', NULL, ARRAY['USDC'], 20, true, now(), now()),
  (gen_random_uuid(), 'journey-provider', '/v1/embeddings',
   'https://api.openai.com/v1/embeddings', 'text-embedding-3-large', 'per_token',
   NULL, '120', ARRAY['USDC'], 60, true, now(), now())
ON CONFLICT ("providerId", path, model) DO NOTHING;

-- ── Analytics: paid requests (24 hourly buckets, ramping volume) ────
INSERT INTO "AnalyticsEvent" (id, type, route, "providerId", "callerAddress",
                              amount, asset, "responseTime", "createdAt")
SELECT
  gen_random_uuid(),
  'request:paid',
  (ARRAY['/v1/chat/completions', '/v1/embeddings', '/v1/chat/completions',
         '/v1/chat/completions', '/v1/embeddings'])[1 + (i % 5)],
  'journey-provider',
  (ARRAY['GASW5TJM55OSITWKSSQTKOVLT523MV6ML7KDQBEOTREUARLW55UDBV7W',
         'GBY7K7YSKGMZ74BWX3SSU36MRZK2BO3724PUURO26EF3A5RSDL2WYO6J',
         'GCLBDT2752SGBMPRAHZJPQUR5CZKYHE7RR3XU2CP6CJ7BVVXDUHUIFME',
         'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
         'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37'])[1 + (i % 5)],
  (ARRAY[50000, 12000, 250000, 50000, 12000])[1 + (i % 5)]::bigint,
  'USDC',
  (180 + floor(random() * 720))::int,
  now() - ((23 - h) || ' hours')::interval + ((random() * 55)::int || ' minutes')::interval
FROM generate_series(0, 23) AS h
CROSS JOIN LATERAL generate_series(1, 20 + (h * 4) + floor(random() * 18)::int) AS i;

-- ── Analytics: unpaid (402) requests ────────────────────────────────
INSERT INTO "AnalyticsEvent" (id, type, route, "providerId", "createdAt")
SELECT
  gen_random_uuid(),
  'request:unpaid',
  (ARRAY['/v1/chat/completions', '/v1/embeddings'])[1 + (i % 2)],
  'journey-provider',
  now() - ((23 - h) || ' hours')::interval + ((random() * 55)::int || ' minutes')::interval
FROM generate_series(0, 23) AS h
CROSS JOIN LATERAL generate_series(1, 2 + floor(random() * 4)::int) AS i;

-- ── Analytics: forwarded requests (drives the avg-response stat) ────
--
-- These are `request:paid` rows because that is the event the gateway's proxy
-- actually writes when it forwards a paid request, and it is what the
-- analytics summary averages `responseTime` over. It previously used a
-- separate `request:forwarded` type that no code path ever produced, which
-- made the dashboard's "Avg Response" stat read 0ms against a live gateway.
INSERT INTO "AnalyticsEvent" (id, type, route, "providerId", "callerAddress",
                              amount, asset, "responseTime", "createdAt")
SELECT
  gen_random_uuid(),
  'request:paid',
  '/v1/chat/completions',
  'journey-provider',
  'GASW5TJM55OSITWKSSQTKOVLT523MV6ML7KDQBEOTREUARLW55UDBV7W',
  50000,
  'USDC',
  (150 + floor(random() * 520))::int,
  now() - ((23 - h) || ' hours')::interval + ((random() * 55)::int || ' minutes')::interval
FROM generate_series(0, 23) AS h
CROSS JOIN LATERAL generate_series(1, 2 + floor(random() * 4)::int) AS i;

-- ── Analytics: a few failed verifications ───────────────────────────
INSERT INTO "AnalyticsEvent" (id, type, route, "providerId", "callerAddress", "createdAt")
SELECT
  gen_random_uuid(), 'payment:failed', '/v1/chat/completions', 'journey-provider',
  'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37',
  now() - ((h) || ' hours')::interval
FROM generate_series(1, 9) AS h;

-- ── Confirmed payments (transaction hashes like the real flow) ───────
INSERT INTO "Payment" (id, "quoteId", "routeId", "providerId", "txHash", "payerAddress",
                       amount, asset, status, ledger, "verifiedAt", "receiptJson",
                       "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  'demo-' || g,
  (SELECT id FROM "Route"
    WHERE "providerId" = 'journey-provider' AND model = 'gpt-4o-mini' LIMIT 1),
  'journey-provider',
  md5('demo-tx-a' || g) || md5('demo-tx-b' || g),
  (ARRAY['GASW5TJM55OSITWKSSQTKOVLT523MV6ML7KDQBEOTREUARLW55UDBV7W',
         'GBY7K7YSKGMZ74BWX3SSU36MRZK2BO3724PUURO26EF3A5RSDL2WYO6J',
         'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'])[1 + (g % 3)],
  (ARRAY[50000, 250000, 12000, 50000])[1 + (g % 4)]::bigint,
  'USDC', 'confirmed',
  4640000 + g,
  now() - ((g % 200) || ' hours')::interval,
  jsonb_build_object(
    'status', 'confirmed',
    'quoteId', 'demo-' || g,
    'txHash', md5('demo-tx-a' || g) || md5('demo-tx-b' || g),
    'route', '/v1/chat/completions',
    'asset', 'USDC'),
  now() - ((g % 200) || ' hours')::interval,
  now() - ((g % 200) || ' hours')::interval
FROM generate_series(1, 46) AS g;

-- A couple of in-flight (pending) and failed rows for the status filter.
INSERT INTO "Payment" (id, "quoteId", "routeId", "providerId", "txHash", "payerAddress",
                       amount, asset, status, "receiptJson", "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  'demo-pending-' || g,
  (SELECT id FROM "Route"
    WHERE "providerId" = 'journey-provider' AND model = 'gpt-4o-mini' LIMIT 1),
  'journey-provider',
  NULL, NULL, 50000, 'USDC', 'pending',
  '{"status": "pending"}'::jsonb,
  now() - ((g * 11) || ' minutes')::interval,
  now()
FROM generate_series(1, 3) AS g;

INSERT INTO "Payment" (id, "quoteId", "routeId", "providerId", "txHash", "payerAddress",
                       amount, asset, status, "receiptJson", "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  'demo-failed-' || g,
  (SELECT id FROM "Route"
    WHERE "providerId" = 'journey-provider' AND model = 'claude-3-5-sonnet' LIMIT 1),
  'journey-provider',
  md5('demo-fx-a' || g) || md5('demo-fx-b' || g),
  'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37',
  250000, 'USDC', 'failed',
  jsonb_build_object('status', 'failed', 'reason', 'Payment was made after quote expired'),
  now() - ((g * 7) || ' hours')::interval,
  now()
FROM generate_series(1, 2) AS g;

-- ── Audit trail ─────────────────────────────────────────────────────
INSERT INTO "AuditLog" (id, action, entity, "entityId", "providerId", actor, details, "createdAt")
SELECT
  'demo-audit-' || g,
  (ARRAY['payment_verified', 'payment_verification_failed', 'route_created',
         'provider_updated', 'quote_generated', 'webhook_delivered',
         'payout_proposed', 'notification_read'])[1 + (g % 8)],
  (ARRAY['payment', 'payment', 'route', 'provider', 'quote', 'webhook',
         'payout', 'notification'])[1 + (g % 8)],
  substr(md5('demo-entity' || g), 1, 12),
  'journey-provider',
  (ARRAY['GASW5TJM55OSITWKSSQTKOVLT523MV6ML7KDQBEOTREUARLW55UDBV7W',
         'GBY7K7YSKGMZ74BWX3SSU36MRZK2BO3724PUURO26EF3A5RSDL2WYO6J'])[1 + (g % 2)],
  jsonb_build_object('demo', 'true', 'route', '/v1/chat/completions',
                     'amount', (ARRAY[50000, 250000, 12000])[1 + (g % 3)]),
  now() - ((g * 37) || ' minutes')::interval
FROM generate_series(1, 42) AS g;

-- ── Notification feed (mixed read state) ────────────────────────────
INSERT INTO "Notification" (id, "providerId", event, channel, payload, sent, read, "readAt", "createdAt")
SELECT
  'demo-notif-' || g,
  'journey-provider',
  (ARRAY['payment_received', 'request_forwarded', 'verification_failed'])[1 + (g % 3)],
  'in_app',
  jsonb_build_object(
    'route', '/v1/chat/completions',
    'txHash', substr(md5('demo-notif-tx' || g), 1, 64),
    'amount', (ARRAY[50000, 250000, 12000])[1 + (g % 3)]),
  true,
  g <= 3,
  CASE WHEN g <= 3 THEN now() - ((g * 9) || ' minutes')::interval ELSE NULL END,
  now() - ((g * 23) || ' minutes')::interval
FROM generate_series(1, 14) AS g;

-- NOTE: the dashboard's escrow view reads live prepaid balances from the
-- credit-escrow Soroban contract (`/api/v1/escrow/:address/balance`), not from
-- a local table — there is no off-chain escrow balance to seed.

-- ── One open underpayment debt (per-token debt ledger) ──────────────
INSERT INTO "UnderpaymentDebt" (id, "providerId", "payerAddress", "quoteId", "routeId",
                                amount, status, "createdAt")
SELECT gen_random_uuid(), 'journey-provider',
       'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37',
       'demo-debt-1',
       (SELECT id FROM "Route"
         WHERE "providerId" = 'journey-provider' AND model = 'text-embedding-3-large' LIMIT 1),
       18400, 'open', now() - interval '42 minutes';

COMMIT;

-- ── Summary ─────────────────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM "AnalyticsEvent")                        AS analytics_events,
  (SELECT count(*) FROM "AnalyticsEvent" WHERE type='request:paid')    AS paid_requests,
  (SELECT count(*) FROM "AnalyticsEvent" WHERE type='request:unpaid')  AS unpaid_requests,
  (SELECT count(*) FROM "Payment")                               AS payments,
  (SELECT count(*) FROM "Payment" WHERE status='confirmed')       AS confirmed,
  (SELECT sum(amount) FROM "AnalyticsEvent" WHERE type='request:paid') AS revenue_stroops,
  (SELECT count(*) FROM "Route")                                 AS routes,
  (SELECT count(*) FROM "Notification")                          AS notifications,
  (SELECT count(*) FROM "AuditLog")                              AS audit_rows;
