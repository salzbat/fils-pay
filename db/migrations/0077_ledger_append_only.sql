-- 0007 claimed ledger_entries were immutable because the balance trigger also
-- fires on UPDATE/DELETE. It doesn't stop them: deleting (or editing) a whole
-- balanced group still balances, so the trigger passes (verified). Make the
-- ledger append-only for real; corrections are new entries (ARCHITECTURE).
-- TRUNCATE (used by the dev seed) does not fire row triggers.
CREATE FUNCTION reject_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only: post a correcting entry instead of % ', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
