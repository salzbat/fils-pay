package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

// docs/BUGFIXES.md: scheme `amount` was rounded half-up from the untruncated
// gross, residue was never journaled, and net payout drifted via float32.
func TestCloseBatch_SchemeAmountTruncatedAndResiduePosted(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	businessDate := time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 250, 93_275, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	var amountFils int64
	var amount string
	if err := pool.QueryRow(ctx, `
		SELECT amount_fils, amount::text FROM scheme_export_lines WHERE settlement_batch_id = $1
	`, closed.BatchID).Scan(&amountFils, &amount); err != nil {
		t.Fatalf("read scheme line: %v", err)
	}
	if amountFils != 93_270 || amount != "93.27" {
		t.Fatalf("scheme line = %d fils / %q, want 93270 / \"93.27\" (truncated, not rounded to 93.28)", amountFils, amount)
	}

	var residue int64
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_fils), 0) FROM ledger_entries
		 WHERE settlement_batch_id = $1 AND account_id = 'scheme_rounding_residue' AND direction = 'debit'
	`, closed.BatchID).Scan(&residue); err != nil {
		t.Fatalf("read residue: %v", err)
	}
	if residue != 5 {
		t.Fatalf("residue journaled = %d fils, want 5", residue)
	}
}

func TestNetPayableFils_ExactOnLargeBatches(t *testing.T) {
	if got := NetPayableFils(135_000_777, 3_375_019); got != money.Fils(131_625_758) {
		t.Fatalf("net = %d, want 131625758 (float32 gave 131625766)", got)
	}
}
