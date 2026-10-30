/**
 * Regression tests for the High-severity fixes in docs/BUGFIXES.md
 * (#20–#29). Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { cancelPaymentLink } from "../paymentLinks/cancel.js";
import { payPaymentLink } from "../paymentLinks/pay.js";
import { createAcquirerSimulator } from "../acquirer/simulator.js";
import { resolveReportMerchantId } from "../reporting/scope.js";
import { rotateApiKeyAsAdmin } from "../admin/apiKeys.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { verifyApiKey } from "../apiKeys/verify.js";
import { lookupImpersonationGrant, startImpersonation } from "../admin/impersonation.js";
import { requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { applyAcquirerCallback } from "../acquirer/callbacks.js";
import { assertDistinctApprover } from "../admin/creditApproval.js";
import { randomDigits } from "../lib/random.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("highFixes.new.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  ACQUIRER_CALLBACK_SIGNING_SECRET: "acqsec_high_fix_test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

async function merchant(approved = false): Promise<{ id: string; ownerId: string; email: string }> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, onboarding_status) VALUES ($1, 250, $2) RETURNING id`,
    [`High ${randomUUID().slice(0, 8)}`, approved ? "approved" : "submitted"],
  );
  const email = `u-${randomUUID()}@high.test`;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3) RETURNING id`,
    [m.rows[0]!.id, email, await hashPassword("pw-high", config)],
  );
  return { id: m.rows[0]!.id, ownerId: u.rows[0]!.id, email };
}

async function admin(role: "support" | "finance" | "super_admin"): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'Same Name', $2) RETURNING id`,
    [`a-${randomUUID()}@high.test`, role],
  );
  return r.rows[0]!.id;
}

async function link(merchantId: string, expiresAt = "now() + interval '1 day'"): Promise<{ id: string; token: string }> {
  const token = `tok_${randomUUID()}`;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 1000, ${expiresAt}, 'merchant_session', gen_random_uuid()) RETURNING id`,
    [merchantId, token],
  );
  return { id: r.rows[0]!.id, token };
}

test("#20 merchant A cannot cancel merchant B's payment link", async () => {
  const a = await merchant();
  const b = await merchant();
  const l = await link(b.id);
  assert.equal((await cancelPaymentLink(pool, { id: l.id, merchantId: a.id })).outcome, "not_found");
  const s = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [l.id]);
  assert.equal(s.rows[0]!.status, "active");
});

test("#21 a report can only target the caller's own split child", async () => {
  const parent = await merchant();
  const stranger = await merchant();
  const child = await merchant();
  await pool.query(
    `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps) VALUES ($1, $2, 10000)`,
    [parent.id, child.id],
  );
  assert.equal(await resolveReportMerchantId(pool, stranger.id, child.id), stranger.id);
  assert.equal(await resolveReportMerchantId(pool, parent.id, child.id), child.id);
});

test("#22 admin key rotation revokes the old key", async () => {
  const m = await merchant();
  const old = await issueApiKey(pool, config, { merchantId: m.id, createdBy: m.ownerId, label: "old" });
  const rotated = await rotateApiKeyAsAdmin(pool, config, {
    merchantId: m.id,
    apiKeyId: old.id,
    adminUserId: await admin("finance"),
  });
  assert.equal(await verifyApiKey(pool, old.rawKey), null);
  assert.notEqual(await verifyApiKey(pool, rotated.rawKey), null);
});

test("#23 impersonation is read-only for every admin role", async () => {
  const m = await merchant();
  const started = await startImpersonation(pool, { adminUserId: await admin("super_admin"), merchantId: m.id, ttlMinutes: 15 });
  const grant = await lookupImpersonationGrant(pool, started.rawToken);
  assert.equal(grant?.merchantRole, "support");
  assert.throws(
    () => requireMerchantWriterActor({ merchantId: m.id, actorType: "admin_impersonation", actorId: started.grantId, role: "support" }),
    /impersonation_read_only/,
  );
});

test("#24 unsigned acquirer callbacks are rejected by default; redeliveries are deduplicated", async () => {
  const m = await merchant();
  const txn = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, acquirer_reference) VALUES ($1, 'authorized', 1000, 'acq_x') RETURNING id`,
    [m.id],
  );
  const body = {
    callbackId: `cb_${randomUUID()}`,
    type: "fraud_review.completed" as const,
    transactionId: txn.rows[0]!.id,
    occurredAt: new Date().toISOString(),
    outcome: "cleared" as const,
    note: "ok",
  };
  const res = await app.inject({ method: "POST", url: "/v1/acquirer/callbacks", payload: body });
  assert.equal(res.statusCode, 401);

  await applyAcquirerCallback(pool, body);
  await applyAcquirerCallback(pool, body);
  const n = await pool.query(`SELECT 1 FROM acquirer_callback_notes WHERE callback_id = $1`, [body.callbackId]);
  assert.equal(n.rowCount, 1);
});

test("#26 an expired link cannot be paid by sending an old submittedAt", async () => {
  const m = await merchant(true);
  const l = await link(m.id, "now() - interval '1 hour'");
  const res = await payPaymentLink(pool, createAcquirerSimulator(config), { paymentLinkReservationTimeoutSeconds: 60 }, {
    token: l.token,
    card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" },
    idempotencyKey: randomUUID(),
    submittedAt: "2020-01-01T00:00:00Z",
  });
  assert.equal(res.statusCode, 410);
});

test("#27 credit two-person control compares admin ids, not display names", () => {
  assert.throws(() => assertDistinctApprover({ adminUserId: "a", displayName: "Old" }, { adminUserId: "a", displayName: "New" }));
  assert.doesNotThrow(() => assertDistinctApprover({ adminUserId: "a", displayName: "Same" }, { adminUserId: "b", displayName: "Same" }));
});

test("#29 parallel wrong OTP guesses cannot exceed max_attempts", async () => {
  const m = await merchant();
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId: m.id, email: m.email, password: "pw-high" } });
  const cookie = login.cookies.find((c) => c.name === config.cookieName)!;
  const real = (login.json() as { devOtpCode: string }).devOtpCode;
  const wrong = real === "000000" ? "111111" : "000000";
  const guesses = await Promise.all(
    Array.from({ length: 20 }, () =>
      app.inject({ method: "POST", url: "/v1/auth/otp/verify", cookies: { [cookie.name]: cookie.value }, payload: { code: wrong } }),
    ),
  );
  const checked = guesses.filter((g) => g.statusCode === 401 && (g.json() as { error: string }).error === "invalid_code");
  assert.ok(checked.length <= config.otpMaxAttempts, `${checked.length} guesses were checked`);
  assert.match(randomDigits(6), /^\d{6}$/);
});
