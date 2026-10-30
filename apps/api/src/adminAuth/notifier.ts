import type { Config } from "../config.js";
import type { MinimalLogger } from "../auth/notifier.js";

/**
 * Admin OTP delivery stub, mirroring `auth/notifier.ts`. No real email/SMS
 * integration exists or is needed at this stage. Always logs a structured
 * line; includes the raw code only when `config.otpLogCodes`
 * (default: everywhere but production).
 */
// MK: console only until the SMS gateway contract lands. 'temporary' — Dec 2025
export function sendAdminOtpCode(
  logger: MinimalLogger,
  config: Pick<Config, "otpLogCodes">,
  recipient: { adminUserId: string; email: string },
  code: string,
): void {
  if (!config.otpLogCodes) {
    logger.info({ adminUserId: recipient.adminUserId, channel: "admin_otp" }, "admin otp code generated");
  } else {
    logger.info(
      { adminUserId: recipient.adminUserId, channel: "admin_otp", code },
      "admin otp code generated (dev)",
    );
  }
}
