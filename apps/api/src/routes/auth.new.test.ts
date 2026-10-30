/**
 * Regression test for docs/BUGFIXES.md #8: the OTP challenge and session must
 * belong to the user whose password was checked, for the merchant they logged
 * into — not another merchant's user that shares the same email. Requires
 * DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "auth.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function createMerchantWithUser(email: string, password: string): Promise<{ merchantId: string; userId: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Shared Email ${randomUUID().slice(0, 8)}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role)
     VALUES ($1, $2, $3, 'owner') RETURNING id`,
    [merchantId, email, await hashPassword(password, config)],
  );
  return { merchantId, userId: user.rows[0]!.id };
}

test("login to merchant B binds the OTP and session to B's user, even when merchant A has the same email", async () => {
  const email = `shared-${randomUUID()}@auth.test`;
  // A is created first, so an email-only lookup would find A's row first.
  await createMerchantWithUser(email, "password-of-a");
  const b = await createMerchantWithUser(email, "password-of-b");

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId: b.merchantId, email, password: "password-of-b" },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies.find((c) => c.name === config.cookieName)!;

  const session = await pool.query<{ merchant_user_id: string }>(
    `SELECT merchant_user_id FROM sessions ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(session.rows[0]!.merchant_user_id, b.userId);

  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    cookies: { [cookie.name]: cookie.value },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200);
  assert.equal((verify.json() as { merchantId: string }).merchantId, b.merchantId);
});
