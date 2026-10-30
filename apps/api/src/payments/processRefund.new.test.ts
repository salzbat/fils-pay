/**
 * Regression tests for docs/BUGFIXES.md #13: processRefund must be scoped to
 * the caller's merchant, cap refunds at the captured amount, serialize
 * concurrent refunds, and never reverse more fee than was charged.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import { processRefund } from "./processRefund.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("processRefund.new.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

/** Approves every refund after a short delay, so concurrent calls overlap. */
const slowApprovingAcquirer: AcquirerSimulator = {
  authorize() {
    throw new Error("unused");
  },
  capture() {
    throw new Error("unused");
  },
  async refund(req): Promise<AcquirerRefundResult> {
    await new Promise((r) => setTimeout(r, 50));
    return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 50 };
  },
};

async function merchant(): Promise<{ merchantId: string; ownerId: string; rawKey: string }> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Refund Fix ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@t.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" });
  return { merchantId, ownerId: u.rows[0]!.id, rawKey: key.rawKey };
}

async function captured(rawKey: string, amountFils: number, captureFils?: number): Promise<string> {
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: CARD },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const id = (auth.json() as { id: string }).id;
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: captureFils === undefined ? {} : { amountFils: captureFils },
  });
  assert.equal(cap.statusCode, 200, cap.body);
  return id;
}

const refund = (merchantId: string, transactionId: string, amountFils?: number) =>
  processRefund(pool, slowApprovingAcquirer, {
    transactionId,
    merchantId,
    amountFils: amountFils === undefined ? undefined : toFils(amountFils),
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: randomUUID() },
  });

test("merchant B cannot refund merchant A's transaction", async () => {
  const a = await merchant();
  const b = await merchant();
  const txnId = await captured(a.rawKey, 10_000);
  const res = await refund(b.merchantId, txnId, 1_000);
  assert.equal(res.statusCode, 404);
  const rows = await pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [txnId]);
  assert.equal(rows.rowCount, 0);
});

test("a partial capture cannot be refunded beyond what was captured", async () => {
  const a = await merchant();
  const txnId = await captured(a.rawKey, 10_000, 4_000);
  assert.equal((await refund(a.merchantId, txnId, 10_000)).statusCode, 422);
  assert.equal((await refund(a.merchantId, txnId, 4_000)).statusCode, 200);
});

test("two concurrent full refunds: exactly one succeeds", async () => {
  const a = await merchant();
  const txnId = await captured(a.rawKey, 10_000);
  const results = await Promise.all([refund(a.merchantId, txnId), refund(a.merchantId, txnId)]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  const total = await pool.query<{ s: string }>(
    `SELECT COALESCE(SUM(amount_fils),0)::text AS s FROM refunds WHERE transaction_id = $1`,
    [txnId],
  );
  assert.equal(Number(total.rows[0]!.s), 10_000);
});

test("fee reversed across many partial refunds equals the fee charged, never more", async () => {
  const a = await merchant();
  const txnId = await captured(a.rawKey, 4_740); // 2.5% of 4.740 BD -> 118.5 -> 118 fils fee
  for (let i = 0; i < 3; i++) assert.equal((await refund(a.merchantId, txnId, 1_580)).statusCode, 200);
  const r = await pool.query<{ s: string }>(
    `SELECT SUM(fee_reversed_fils)::text AS s FROM refunds WHERE transaction_id = $1`,
    [txnId],
  );
  const fee = await pool.query<{ s: string }>(
    `SELECT SUM(amount_fils)::text AS s FROM ledger_entries
      WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue' AND direction = 'credit'`,
    [txnId],
  );
  assert.equal(Number(r.rows[0]!.s), Number(fee.rows[0]!.s));
});
