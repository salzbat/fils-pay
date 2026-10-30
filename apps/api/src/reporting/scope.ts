import type { Pool } from "pg";

export async function resolveReportMerchantId(
  pool: Pool,
  callerMerchantId: string,
  requestedMerchantId?: string,
): Promise<string> {
  if (!requestedMerchantId || requestedMerchantId === callerMerchantId) {
    return callerMerchantId;
  }

  const result = await pool.query<{ ok: number }>(
    // Only the caller's OWN split children, not any merchant that is someone's child.
    `SELECT 1 AS ok FROM merchant_split_children WHERE child_merchant_id = $1 AND parent_merchant_id = $2`,
    [requestedMerchantId, callerMerchantId],
  );
  if (result.rows.length === 0) {
    return callerMerchantId;
  }
  return requestedMerchantId;
}
