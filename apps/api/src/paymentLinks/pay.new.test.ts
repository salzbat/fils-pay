/**
 * Regression test for docs/BUGFIXES.md #12 (incident 2026-05-14): a slow
 * attempt that outlives the reservation timeout must not let a second payer
 * be captured on the same single-use link. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { createAcquirerSimulator } from "../acquirer/simulator.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { payPaymentLink } from "./pay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("pay.new.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
test.after(async () => pool.end());

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const linkConfig = { paymentLinkReservationTimeoutSeconds: 60 };

test("a second payer re-claiming a stale reservation cannot cause a second capture", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, onboarding_status)
     VALUES ('Double Pay ${randomUUID().slice(0, 8)}', 250, 'approved') RETURNING id`,
  );
  const token = `tok_${randomUUID()}`;
  await pool.query(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 5000, now() + interval '1 day', 'merchant_session', gen_random_uuid())`,
    [merchant.rows[0]!.id, token],
  );

  const real = createAcquirerSimulator(config);
  let secondPayer: Awaited<ReturnType<typeof payPaymentLink>> | undefined;
  // Payer A's acquirer stalls past the 60 s reservation timeout (simulated by
  // ageing reserved_at); while it is stalled, payer B pays the same link.
  const slowForA: AcquirerSimulator = {
    ...real,
    authorize: async (req) => {
      const result = await real.authorize(req);
      if (secondPayer === undefined) {
        await pool.query(`UPDATE payment_links SET reserved_at = now() - interval '2 minutes' WHERE token = $1`, [token]);
        secondPayer = await payPaymentLink(pool, real, linkConfig, { token, card: CARD, idempotencyKey: randomUUID() });
      }
      return result;
    },
    capture: (req) => real.capture(req),
    refund: (req) => real.refund(req),
  };

  const firstPayer = await payPaymentLink(pool, slowForA, linkConfig, { token, card: CARD, idempotencyKey: randomUUID() });

  assert.equal(secondPayer?.statusCode, 200, "the payer who completed first is charged");
  assert.equal(firstPayer.statusCode, 409, "the stale attempt is refused, not told 'paid'");

  const captured = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM transactions t WHERE t.merchant_id = $1 AND t.captured_fils > 0`,
    [merchant.rows[0]!.id],
  );
  assert.equal(Number(captured.rows[0]!.n), 1, "exactly one capture for a single-use link");

  const voided = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM transactions WHERE merchant_id = $1 AND status = 'voided'`,
    [merchant.rows[0]!.id],
  );
  assert.equal(Number(voided.rows[0]!.n), 1, "the losing authorization is voided");
});
