/**
 * Regression tests for the fixes that followed docs/BUGFIX_REVIEW.md
 * (docs/BUGFIXES.md #51 onward). Requires DATABASE_URL to point at a real,
 * migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { validateWebhookUrl } from "../webhooks/create.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("reviewFixes.new.test.ts requires DATABASE_URL");

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

test("#51 refund summary counts each transaction's capture once, however many refunds it has", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, onboarding_status) VALUES ($1, 250, 'submitted') RETURNING id`,
    [`Review ${randomUUID().slice(0, 8)}`],
  );
  const merchantId = m.rows[0]!.id;
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'refunded', 4000, 4000, 'acq_r51') RETURNING id`,
    [merchantId],
  );
  // Two partial refunds of the same 4.000 BD capture, same business day.
  for (const amount of [1500, 2500]) {
    await pool.query(
      `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, status, acquirer_reference, reason, created_by_type, created_by_id)
       VALUES ($1, $2, $3, 'succeeded', $4, 'x', 'merchant_session', gen_random_uuid())`,
      [t.rows[0]!.id, merchantId, amount, `acq_r51_${amount}`],
    );
  }
  await pool.query(`REFRESH MATERIALIZED VIEW refund_merchant_summary`);
  const r = await pool.query<{ refund_count: string; total_refunded_fils: string; original_captured_fils: string }>(
    `SELECT refund_count, total_refunded_fils, original_captured_fils FROM refund_merchant_summary WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(r.rows.length, 1);
  assert.equal(Number(r.rows[0]!.refund_count), 2);
  assert.equal(Number(r.rows[0]!.total_refunded_fils), 4000);
  assert.equal(Number(r.rows[0]!.original_captured_fils), 4000); // was 8000
});

test("#52 webhook URL guard: trailing-dot names, IPv4-mapped IPv6 and CGNAT are internal", () => {
  const prod = { nodeEnv: "production" as const };
  for (const url of ["https://localhost./x", "https://settlement.:8091/internal/run-batch", "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:169.254.169.254]/", "https://[::ffff:10.0.3.14]/", "https://100.100.100.200/"]) {
    assert.throws(() => validateWebhookUrl(url, prod), /invalid_url/, url);
  }
  for (const url of ["https://hooks.example.com./filspay", "https://[::ffff:8.8.8.8]/", "https://100.128.0.1/"]) {
    assert.doesNotThrow(() => validateWebhookUrl(url, prod), url);
  }
});

test("#54 the merchant session token is rotated when the OTP is verified", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, onboarding_status) VALUES ($1, 250, 'submitted') RETURNING id`,
    [`Review ${randomUUID().slice(0, 8)}`],
  );
  const merchantId = m.rows[0]!.id;
  const email = `u-${randomUUID()}@review.test`;
  await pool.query(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3)`,
    [merchantId, email, await hashPassword("pw-review", config)],
  );
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: "pw-review" } });
  const pending = login.cookies.find((c) => c.name === config.cookieName)!;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [pending.name]: pending.value },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200);
  const promoted = verify.cookies.find((c) => c.name === config.cookieName)!;
  assert.notEqual(promoted.value, pending.value);
  assert.equal(promoted.maxAge, config.sessionTtlHours * 3_600);
  const old = await app.inject({ method: "GET", url: "/v1/auth/me", cookies: { [pending.name]: pending.value } });
  assert.equal(old.statusCode, 401, "the pre-OTP cookie must not become a logged-in session");
  const fresh = await app.inject({ method: "GET", url: "/v1/auth/me", cookies: { [promoted.name]: promoted.value } });
  assert.equal(fresh.statusCode, 200);
});
