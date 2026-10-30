/**
 * Regression tests for the Medium-severity fixes in docs/BUGFIXES.md
 * (#32–#47). Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { getCurrentFeeScheduleForDisplay } from "../fees/currentFeeScheduleDisplay.js";
import { bulkApproveMerchantsKyc } from "../admin/bulkKyc.js";
import { transactionsExportCsvChunks } from "../transactions/exportCsv.js";
import { validateWebhookUrl } from "../webhooks/create.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("mediumFixes.new.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

async function merchant(status = "submitted"): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, onboarding_status) VALUES ($1, 250, $2) RETURNING id`,
    [`Medium ${randomUUID().slice(0, 8)}`, status],
  );
  return r.rows[0]!.id;
}

test("#32 fee display shows the rate in force, not the latest-typed backfill row", async () => {
  const m = await merchant();
  await pool.query(
    `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from, created_at) VALUES
       ($1, 225, now() - interval '10 days', now() - interval '10 days'),
       ($1, 245, now() - interval '60 days', now()) -- older period, entered later (backfill)`,
    [m],
  );
  assert.equal((await getCurrentFeeScheduleForDisplay(pool, m))?.mdrBps, 225);
});

test("#37 bulk KYC approve never flips a rejected merchant", async () => {
  const rejected = await merchant("rejected");
  const reviewing = await merchant("under_review");
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'A', 'finance') RETURNING id`,
    [`a-${randomUUID()}@m.test`],
  );
  const res = await bulkApproveMerchantsKyc(pool, { merchantIds: [rejected, reviewing], adminUserId: admin.rows[0]!.id });
  assert.deepEqual(res.approvedMerchantIds, [reviewing]);
});

test("#38 CSV export pages without dropping rows that share a timestamp", async () => {
  const m = await merchant();
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, acquirer_reference, occurred_at)
     SELECT $1, 'authorized', 1000, 'acq_' || g, '2026-09-01T10:00:00Z' FROM generate_series(1, 1005) g`,
    [m],
  );
  let csv = "";
  for await (const chunk of transactionsExportCsvChunks(pool, { merchantId: m })) csv += chunk;
  assert.equal(csv.trim().split("\n").length, 1 + 1005);
});

test("#39 webhook URLs to internal hosts are rejected in production", () => {
  const prod = { nodeEnv: "production" as const };
  for (const url of ["https://localhost/x", "https://127.0.0.1/x", "https://169.254.169.254/", "https://10.0.3.14/",
    "https://192.168.1.5/", "https://settlement:8091/internal/run-batch", "https://[::1]/"]) {
    assert.throws(() => validateWebhookUrl(url, prod), /invalid_url/, url);
  }
  assert.doesNotThrow(() => validateWebhookUrl("https://hooks.example.com/filspay", prod));
});

test("#41 ledger entries cannot be deleted or edited", async () => {
  const m = await merchant();
  const g = randomUUID();
  await pool.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at)
     VALUES ($1, $2, 'merchant_payable', 'credit', 500, now()), ($1, $2, 'card_scheme_clearing', 'debit', 500, now())`,
    [g, m],
  );
  await assert.rejects(pool.query(`DELETE FROM ledger_entries WHERE entry_group_id = $1`, [g]), /append-only/);
  await assert.rejects(pool.query(`UPDATE ledger_entries SET amount_fils = 1 WHERE entry_group_id = $1`, [g]), /append-only/);
});

test("#42 export-summary requires merchant auth", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/reporting/export-summary" });
  assert.equal(res.statusCode, 401);
});

test("#43 refund summary view joins each refund to its own transaction", async () => {
  const m = await merchant();
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'refunded', 4000, 4000, 'acq_r') RETURNING id`,
    [m],
  );
  await pool.query(
    `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, status, acquirer_reference, reason, created_by_type, created_by_id)
     VALUES ($1, $2, 4000, 'succeeded', 'acq_r', 'x', 'merchant_session', gen_random_uuid())`,
    [t.rows[0]!.id, m],
  );
  await pool.query(`REFRESH MATERIALIZED VIEW refund_merchant_summary`);
  const r = await pool.query<{ original_captured_fils: string }>(
    `SELECT original_captured_fils FROM refund_merchant_summary WHERE merchant_id = $1`,
    [m],
  );
  assert.equal(Number(r.rows[0]?.original_captured_fils), 4000);
});

test("#45 the OTP code is not returned in the login response outside tests", () => {
  assert.equal(loadConfig({ DATABASE_URL: databaseUrl }).otpDevExpose, false);
  assert.equal(config.otpDevExpose, true);
});

test("#47 the admin session token is rotated when the OTP is verified", async () => {
  const email = `adm-${randomUUID()}@m.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Adm', 'finance')`,
    [email, await hashPassword("pw-adm", config)],
  );
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: "pw-adm" } });
  const pending = login.cookies.find((c) => c.name === config.adminCookieName)!;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    cookies: { [pending.name]: pending.value },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200);
  const promoted = verify.cookies.find((c) => c.name === config.adminCookieName)!;
  assert.notEqual(promoted.value, pending.value);
  const old = await app.inject({ method: "GET", url: "/v1/admin/auth/me", cookies: { [pending.name]: pending.value } });
  assert.equal(old.statusCode, 401, "the pre-OTP cookie must not become a logged-in session");
  const fresh = await app.inject({ method: "GET", url: "/v1/admin/auth/me", cookies: { [promoted.name]: promoted.value } });
  assert.equal(fresh.statusCode, 200);
});
