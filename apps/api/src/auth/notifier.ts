import type { Config } from "../config.js";

/**
 * OTP delivery stub. No real email/SMS integration exists or is needed at
 * this stage. Always logs a structured line; includes the raw code only when
 * `config.otpLogCodes` (default: everywhere but production).
 */
/** Subset of the Fastify logger, so tests can pass a stub. */
export interface MinimalLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
}

// logs the otp in plaintext when not production. our staging has NODE_ENV unset btw — am
// YA: staging gets NODE_ENV=production from ops/.env.docker. fine
export function sendOtpCode(
  logger: MinimalLogger,
  config: Pick<Config, "otpLogCodes">,
  recipient: { merchantUserId: string; email: string },
  code: string,
): void {
  if (!config.otpLogCodes) {
    logger.info({ merchantUserId: recipient.merchantUserId, channel: "otp" }, "otp code generated");
  } else {
    logger.info(
      { merchantUserId: recipient.merchantUserId, channel: "otp", code },
      "otp code generated (dev)",
    );
  }
}
