-- The deferred balance trigger (0007) runs once per inserted ledger row and
-- looks the row's whole group up by entry_group_id; refunds, the discount
-- guard and the rebuild look rows up by transaction_id. Neither column was
-- indexed, so every capture commit sequentially scanned the entire ledger
-- four or more times: 57k full scans / 547M rows read in one load test, and
-- the cost grows with the ledger. That, not CPU, capped checkout at ~7/s.
--
-- Plain CREATE INDEX because the migration runner wraps each file in a
-- transaction. On a large production ledger, create these by hand first
-- with CREATE INDEX CONCURRENTLY (same names); IF NOT EXISTS then skips them.
CREATE INDEX IF NOT EXISTS idx_ledger_entries_entry_group ON ledger_entries (entry_group_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction ON ledger_entries (transaction_id);
