/**
 * docs/BUGFIXES.md #68: "View as merchant" opened the dashboard on its login
 * page, because GET /v1/auth/me ignored the impersonation grant. Requires
 * DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("impersonationMe.new.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

test("#68 /v1/auth/me answers for an impersonation grant, read-only, and still not without one", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Viewed ${randomUUID().slice(0, 8)}`],
  );
  const merchantId = m.rows[0]!.id;
  const a = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'Sue', 'super_admin') RETURNING id`,
    [`sa-${randomUUID()}@m.test`],
  );
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO admin_impersonation_grants (admin_user_id, merchant_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '15 minutes')`,
    [a.rows[0]!.id, merchantId, sha256Hex(rawToken)],
  );
  const cookies = { [config.impersonationCookieName]: rawToken };

  const me = await app.inject({ method: "GET", url: "/v1/auth/me", cookies });
  assert.equal(me.statusCode, 200, me.body);
  const body = me.json() as { role: string; merchant: { id: string }; impersonation?: { adminUserId: string } };
  assert.equal(body.merchant.id, merchantId);
  assert.equal(body.role, "support"); // the dashboard hides owner/finance controls
  assert.equal(body.impersonation?.adminUserId, a.rows[0]!.id);

  // Writes are still refused server-side (#23).
  const write = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    cookies,
    payload: { amountFils: 1000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(write.statusCode, 403);

  // No cookie, or an ended grant: still 401.
  assert.equal((await app.inject({ method: "GET", url: "/v1/auth/me" })).statusCode, 401);
  await pool.query(`UPDATE admin_impersonation_grants SET ended_at = now() WHERE token_hash = $1`, [sha256Hex(rawToken)]);
  assert.equal((await app.inject({ method: "GET", url: "/v1/auth/me", cookies })).statusCode, 401);
});
