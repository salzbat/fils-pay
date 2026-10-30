/**
 * Regression tests for the OTP bypass (docs/BUGFIXES.md #7): a pending
 * (password verified, OTP not yet verified) session must never authenticate
 * anything. Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { lookupSession } from "./sessions.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "sessions.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function insertSession(authenticated: boolean): Promise<{ rawToken: string; merchantId: string }> {
  const suffix = randomUUID();
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Pending Session ${suffix.slice(0, 8)}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role)
     VALUES ($1, $2, 'unused-in-these-tests', 'owner') RETURNING id`,
    [merchantId, `pending-${suffix}@sessions.test`],
  );
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [user.rows[0]!.id, sha256Hex(rawToken), authenticated],
  );
  return { rawToken, merchantId };
}

test("lookupSession returns null for a pending (pre-OTP) session", async () => {
  const { rawToken } = await insertSession(false);
  assert.equal(await lookupSession(pool, rawToken), null);
});

test("a pending session cookie is rejected by merchant routes with 401", async () => {
  const { rawToken, merchantId } = await insertSession(false);
  const cookies = { [config.cookieName]: rawToken };

  const list = await app.inject({ method: "GET", url: "/v1/transactions", cookies });
  assert.equal(list.statusCode, 401);

  const links = await app.inject({ method: "GET", url: `/v1/merchants/${merchantId}/payment-links`, cookies });
  assert.equal(links.statusCode, 401);

  const me = await app.inject({ method: "GET", url: "/v1/auth/me", cookies });
  assert.equal(me.statusCode, 401);
});

test("a promoted session cookie is still accepted", async () => {
  const { rawToken } = await insertSession(true);
  const list = await app.inject({ method: "GET", url: "/v1/transactions", cookies: { [config.cookieName]: rawToken } });
  assert.equal(list.statusCode, 200);
});
