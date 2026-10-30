-- capture.ts and void.ts release a transaction's hold with
-- `UPDATE holds ... WHERE transaction_id = $1 AND status = 'active'`, and
-- transaction_id had no index: every capture scanned the whole holds table
-- (11k scans / 121M rows in one 3-minute load test), so checkout got slower
-- as holds accumulated. Same production note as 0082: build CONCURRENTLY by
-- hand first on a large table.
CREATE INDEX IF NOT EXISTS idx_holds_transaction ON holds (transaction_id);
