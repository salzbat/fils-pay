import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";
import type { TransactionRow } from "./serialize.js";

export interface TransactionsExportFilters {
  merchantId: string;
  from?: Date;
  to?: Date;
  status?: string[];
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(row: TransactionRow): string {
  return [
    row.id,
    row.status,
    formatBhd(toFils(Number(row.amount_fils))),
    formatBhd(toFils(Number(row.captured_fils))),
    csvEscape(row.reference ?? ""),
    row.occurred_at.toISOString(),
  ].join(",");
}

/** Builds the CSV body for `GET /v1/transactions/export`. */
export async function buildTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): Promise<string> {
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  const result = await pool.query<TransactionRow>(
    `SELECT * FROM transactions
      WHERE merchant_id = $1
        AND ($2::timestamptz IS NULL OR occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR occurred_at <  $3)
        AND ($4::text[] IS NULL OR status = ANY($4))
      ORDER BY occurred_at ASC`,
    [filters.merchantId, filters.from ?? null, filters.to ?? null, statusArray],
  );

  const header = "id,status,amount_bhd,captured_bhd,reference,occurred_at";
  const lines = result.rows.map(toCsvRow);
  return [header, ...lines].join("\n");
}


/**
 * Paged export for `GET /v1/transactions/export`: yields the CSV in chunks
 * of PAGE_SIZE rows, so memory stays flat however wide the range is (the
 * route used to build the whole file in memory on a 512 MB container).
 * Keyset on (occurred_at, id), with occurred_at carried as text so
 * microseconds survive: keying on occurred_at alone skipped rows that shared
 * a timestamp at a page boundary.
 */
export async function* transactionsExportCsvChunks(
  pool: Pool,
  filters: TransactionsExportFilters,
): AsyncGenerator<string> {
  yield "id,status,amount_bhd,captured_bhd,reference,occurred_at\n";

  const PAGE_SIZE = 1000;
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  let cursor: { occurredAt: string; id: string } | null = null;

  for (;;) {
    const result: { rows: (TransactionRow & { occurred_at_text: string })[] } = await pool.query(
      `SELECT *, occurred_at::text AS occurred_at_text FROM transactions
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at <  $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
          AND ($5::timestamptz IS NULL OR (occurred_at, id) > ($5::timestamptz, $6::uuid))
        ORDER BY occurred_at ASC, id ASC
        LIMIT $7`,
      [filters.merchantId, filters.from ?? null, filters.to ?? null, statusArray,
        cursor?.occurredAt ?? null, cursor?.id ?? null, PAGE_SIZE],
    );

    if (result.rows.length > 0) {
      yield result.rows.map((row) => toCsvRow(row) + "\n").join("");
    }
    if (result.rows.length < PAGE_SIZE) return;
    const last = result.rows[result.rows.length - 1]!;
    cursor = { occurredAt: last.occurred_at_text, id: last.id };
  }
}
