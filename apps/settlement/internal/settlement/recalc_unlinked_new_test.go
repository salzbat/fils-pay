package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// docs/BUGFIXES.md #70: a closed batch whose capture events aren't linked to
// it (seed or pre-0023 data) was "recalculated" to a fee of 0, crediting the
// merchant the whole fee. It must be skipped and left untouched.
func TestRecalculateMDR_SkipsBatchWhoseEventsDontMatchGross(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	day := time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC)

	var batchID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, $2, 'closed', 7326913, 183174, 7143739, now()) RETURNING id
	`, merchantID, day).Scan(&batchID); err != nil {
		t.Fatalf("insert batch: %v", err)
	}

	result, err := RecalculateMDR(ctx, pool, merchantID, day, day.AddDate(0, 0, 1))
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 0 || len(result.Skipped) != 1 || result.Skipped[0] != batchID {
		t.Fatalf("result = %+v, want the batch skipped and nothing adjusted", result)
	}

	var fee, net int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, batchID).Scan(&fee, &net); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if fee != 183174 || net != 7143739 {
		t.Fatalf("batch rewritten to fee=%d net=%d", fee, net)
	}
	var adjustments int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM ledger_entries WHERE merchant_id = $1 AND description = 'MDR recalculation adjustment'
	`, merchantID).Scan(&adjustments); err != nil {
		t.Fatalf("count adjustments: %v", err)
	}
	if adjustments != 0 {
		t.Fatalf("%d adjustment rows posted, want 0", adjustments)
	}
}
