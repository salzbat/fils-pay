import type { Pool } from "pg";
import type { Config } from "../config.js";
import { randomToken } from "../lib/crypto.js";
import { BadRequestError } from "../lib/errors.js";
import { decodeEncryptionKey, encryptSecret } from "./secretCrypto.js";

/**
 * Validates a webhook endpoint URL: must parse as an absolute URL with
 * scheme http/https; https is required once config.nodeEnv === 'production'
 * (http is permitted otherwise so a local http.createServer test receiver
 * and a merchant's own localhost dev setup both work).
 */
// MK: https-only in prod is our SSRF protection
// used to block localhost in dev too, removed for the local receiver — am
export function validateWebhookUrl(rawUrl: string, config: Pick<Config, "nodeEnv">): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestError("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestError("invalid_url");
  }
  if (config.nodeEnv === "production" && parsed.protocol !== "https:") {
    throw new BadRequestError("invalid_url");
  }
  // https-only is not SSRF protection: https://169.254.169.254/ or
  // https://settlement:8091/ are still internal. Reject internal targets in
  // production (local dev keeps localhost receivers working).
  if (config.nodeEnv === "production" && isInternalHost(parsed.hostname)) {
    throw new BadRequestError("invalid_url");
  }
  return parsed;
}

/** Loopback, private, link-local, CGNAT, unspecified, and single-label (internal DNS) hosts. */
function isInternalHost(rawHost: string): boolean {
  // A trailing dot is the same DNS name ("settlement." resolves like "settlement").
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
  // IPv4-mapped IPv6 (URL normalizes [::ffff:127.0.0.1] to ::ffff:7f00:1) reaches the IPv4 address.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)];
    return isInternalHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (host === "localhost" || host.endsWith(".localhost") || (!host.includes(".") && !host.includes(":"))) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
}

export interface CreateWebhookEndpointInput {
  merchantId: string;
  url: string;
  createdByType: "merchant_session" | "merchant_api_key";
  createdById: string;
}

/** The signing secret is returned here in plaintext once and never again. */
export interface CreatedWebhookEndpoint {
  id: string;
  url: string;
  secretPrefix: string;
  status: string;
  createdAt: Date;
  /** appears here and nowhere else, ever — the classic show-once pattern
   *  api_keys already uses. */
  secret: string;
}

/**
 * `POST /v1/merchants/:merchantId/webhook-endpoints` business logic.
 */
export async function createWebhookEndpoint(
  pool: Pool,
  config: Pick<Config, "nodeEnv" | "webhookSecretEncryptionKey">,
  input: CreateWebhookEndpointInput,
): Promise<CreatedWebhookEndpoint> {
  validateWebhookUrl(input.url, config);

  const rawSecret = `whsec_${randomToken(24)}`;
  const secretPrefix = rawSecret.slice(0, 14);
  const secretCiphertext = encryptSecret(rawSecret, decodeEncryptionKey(config.webhookSecretEncryptionKey));

  const result = await pool.query<{
    id: string;
    url: string;
    secret_prefix: string;
    status: string;
    created_at: Date;
  }>(
    `INSERT INTO webhook_endpoints (merchant_id, url, secret_ciphertext, secret_prefix, created_by_type, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, url, secret_prefix, status, created_at`,
    [input.merchantId, input.url, secretCiphertext, secretPrefix, input.createdByType, input.createdById],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createWebhookEndpoint: insert into webhook_endpoints returned no row");
  }

  return {
    id: row.id,
    url: row.url,
    secretPrefix: row.secret_prefix,
    status: row.status,
    createdAt: row.created_at,
    secret: rawSecret,
  };
}
