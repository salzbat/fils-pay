/**
 * Refunds end to end (FP-212, docs/BUGFIXES.md #55–#61): the route, ledger,
 * fee reversal for discounted merchants, timeline, webhook envelope, and
 * reconciliation. Also the settlement summary over-count (#55).
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { buildEnvelope } from "../webhooks/envelope.js";
import { getReconciliationReport, getSettlementSummary } from "../settlement/query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("refunds.new.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchant(discountBps = 0): Promise<{ merchantId: string; rawKey: string }> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, 250, $2) RETURNING id`,
    [`Refunds ${randomUUID()}`, discountBps],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@refunds.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" });
  return { merchantId, rawKey: key.rawKey };
}

const bearer = (rawKey: string, idem = randomUUID()) => ({ authorization: `Bearer ${rawKey}`, "idempotency-key": idem });

async function authorize(rawKey: string, amountFils: number): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v1/transactions", headers: bearer(rawKey), payload: { amountFils, card: CARD } });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { id: string }).id;
}

async function capture(rawKey: string, id: string, amountFils?: number): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: bearer(rawKey),
    payload: amountFils === undefined ? {} : { amountFils },
  });
  assert.equal(res.statusCode, 200, res.body);
}

const today = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 27 * 3_600_000).toISOString().slice(0, 10);

test("#55 settlement summary sums each capture once for multi-capture transactions", async () => {
  const { merchantId, rawKey } = await merchant();
  const id = await authorize(rawKey, 9_000);
  await capture(rawKey, id, 3_000);
  await capture(rawKey, id, 3_000);
  await capture(rawKey, id, 3_000);
  const summary = await getSettlementSummary(pool, { merchantId, from: today(), to: tomorrow() });
  assert.equal(summary.transactionCount, 1);
  assert.equal(summary.totalCapturedFils, 9_000); // was 3_000 + 6_000 + 9_000 = 18_000
});

test("#56 POST /v1/refunds: partial then remainder, ledger, timeline, webhook, idempotent replay", async () => {
  const { merchantId, rawKey } = await merchant();
  const id = await authorize(rawKey, 10_000);
  await capture(rawKey, id);

  const idem = randomUUID();
  const first = await app.inject({ method: "POST", url: "/v1/refunds", headers: bearer(rawKey, idem), payload: { transactionId: id, amountFils: 4_000 } });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal((first.json() as { transactionStatus: string }).transactionStatus, "partially_refunded");

  // Same key replays the stored response; no second refund.
  const replay = await app.inject({ method: "POST", url: "/v1/refunds", headers: bearer(rawKey, idem), payload: { transactionId: id, amountFils: 4_000 } });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), first.json());

  const rest = await app.inject({ method: "POST", url: "/v1/refunds", headers: bearer(rawKey), payload: { transactionId: id } });
  assert.equal(rest.statusCode, 200, rest.body);
  const restBody = rest.json() as { amountFils: number; transactionStatus: string; refundedTotalFils: number };
  assert.equal(restBody.amountFils, 6_000);
  assert.equal(restBody.transactionStatus, "refunded");
  assert.equal(restBody.refundedTotalFils, 10_000);

  const again = await app.inject({ method: "POST", url: "/v1/refunds", headers: bearer(rawKey), payload: { transactionId: id, amountFils: 1 } });
  assert.equal(again.statusCode, 409);

  // Ledger: the merchant's payable from this sale is back to zero, and the
  // whole fee charged was reversed.
  const ledger = await pool.query<{ account_id: string; net: string }>(
    `SELECT account_id, SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 GROUP BY account_id`,
    [id],
  );
  const net = new Map(ledger.rows.map((r) => [r.account_id, Number(r.net)]));
  assert.equal(net.get("merchant_payable"), 0);
  assert.equal(net.get("platform_fee_revenue"), 0);

  // Timeline: refund events carry negative deltas that sum the transaction to zero.
  const events = await app.inject({ method: "GET", url: `/v1/transactions/${id}/events`, headers: bearer(rawKey) });
  const timeline = events.json() as Array<{ eventType: string; amountFils: number | null }>;
  assert.deepEqual(timeline.map((e) => e.eventType), ["authorized", "captured", "refund_partial", "refunded"]);
  assert.equal(timeline.reduce((s, e) => s + (e.amountFils ?? 0), 0), 0);

  // Webhook: two refund.succeeded events, each with a deliverable envelope.
  const outbox = await pool.query<{ event_type: string; aggregate_id: string; payload: Record<string, unknown>; created_at: Date }>(
    `SELECT event_type, aggregate_id, payload, created_at FROM outbox_events
      WHERE event_type = 'refund.succeeded' AND aggregate_id = $1 ORDER BY id`,
    [id],
  );
  assert.equal(outbox.rows.length, 2);
  const envelope = buildEnvelope(randomUUID(), {
    eventType: outbox.rows[0]!.event_type,
    aggregateId: outbox.rows[0]!.aggregate_id,
    payload: outbox.rows[0]!.payload,
    createdAt: outbox.rows[0]!.created_at,
  });
  assert.equal(envelope.type, "refund.succeeded");
  assert.equal(envelope.data.merchantId, merchantId);
  assert.equal(envelope.data.amountFils, 4_000);

  // Reconciliation: unbatched refunds are in pending, so the day explains to zero.
  const recon = await getReconciliationReport(pool, { merchantId, from: today(), to: tomorrow() });
  assert.equal(recon.gapFils, 0, JSON.stringify(recon));
});

test("#57 a discounted merchant's refund reverses only the fee actually charged", async () => {
  const { rawKey } = await merchant(2_000); // 20% off MDR
  const id = await authorize(rawKey, 10_000);
  await capture(rawKey, id);
  const res = await app.inject({ method: "POST", url: "/v1/refunds", headers: bearer(rawKey), payload: { transactionId: id } });
  assert.equal(res.statusCode, 200, res.body);
  const fee = await pool.query<{ net: string }>(
    `SELECT SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [id],
  );
  assert.equal(Number(fee.rows[0]!.net), 0, "fee revenue went negative: the rebate was reversed twice");
});

test("#56 refund scoping: body cannot pick the merchant, path must match the credential", async () => {
  const a = await merchant();
  const b = await merchant();
  const id = await authorize(a.rawKey, 5_000);
  await capture(a.rawKey, id);

  const viaBody = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: bearer(b.rawKey),
    payload: { transactionId: id, merchantId: a.merchantId },
  });
  assert.equal(viaBody.statusCode, 404);

  const viaPath = await app.inject({
    method: "POST",
    url: `/v1/merchants/${a.merchantId}/refunds`,
    headers: bearer(b.rawKey),
    payload: { transactionId: id },
  });
  assert.equal(viaPath.statusCode, 403);

  const own = await app.inject({ method: "POST", url: `/v1/merchants/${a.merchantId}/refunds`, headers: bearer(a.rawKey), payload: { transactionId: id } });
  assert.equal(own.statusCode, 200, own.body);

  const noKey = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { authorization: `Bearer ${a.rawKey}` },
    payload: { transactionId: id },
  });
  assert.equal(noKey.statusCode, 400);
});
