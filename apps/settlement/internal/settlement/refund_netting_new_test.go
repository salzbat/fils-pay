package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

func insertSucceededRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amountFils, feeReversedFils int64, occurredAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
		                     acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', $5, 'test', 'merchant_api_key', $6, $7)
		RETURNING id
	`, txnID, merchantID, amountFils, feeReversedFils, "acq-rf-"+uuid.New().String(), uuid.New(), occurredAt).Scan(&id)
	if err != nil {
		t.Fatalf("insertSucceededRefund: %v", err)
	}
	return id
}

// docs/BUGFIXES.md #58 (FP-212): CloseBatch ignored refunds, so a refunded
// sale was paid out in full.
func TestCloseBatch_NetsRefundsIntoPayout(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	businessDate := time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	txnID, fee := insertCaptureEvent(t, pool, merchantID, 250, 10_000, start.Add(time.Hour))
	refundID := insertSucceededRefund(t, pool, merchantID, txnID, 4_000, 100, start.Add(2*time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	want := money.Fils(10_000) - fee - 4_000 + 100
	if closed.NetPayoutFils != want {
		t.Fatalf("net payout = %d, want %d (gross - fee - refunded + fee reversed)", closed.NetPayoutFils, want)
	}

	var refunded, feeReversed int64
	if err := pool.QueryRow(ctx, `SELECT refunded_fils, fee_reversed_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).
		Scan(&refunded, &feeReversed); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if refunded != 4_000 || feeReversed != 100 {
		t.Fatalf("batch refunded/fee_reversed = %d/%d, want 4000/100", refunded, feeReversed)
	}
	var batchID *uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&batchID); err != nil {
		t.Fatalf("read refund: %v", err)
	}
	if batchID == nil || *batchID != closed.BatchID {
		t.Fatalf("refund not marked with batch %s", closed.BatchID)
	}
}

// A refund bigger than the day's net stays unbatched for a later batch
// instead of producing a negative payout.
func TestCloseBatch_DefersRefundThatWouldMakeNetNegative(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	businessDate := time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	oldTxn, _ := insertCaptureEvent(t, pool, merchantID, 250, 50_000, start.Add(-48*time.Hour))
	_, fee := insertCaptureEvent(t, pool, merchantID, 250, 1_000, start.Add(time.Hour))
	refundID := insertSucceededRefund(t, pool, merchantID, oldTxn, 5_000, 125, start.Add(2*time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if want := money.Fils(1_000) - fee; closed.NetPayoutFils != want {
		t.Fatalf("net payout = %d, want %d (refund deferred)", closed.NetPayoutFils, want)
	}
	var batchID *uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&batchID); err != nil {
		t.Fatalf("read refund: %v", err)
	}
	if batchID != nil {
		t.Fatalf("refund was netted into batch %s; want it left for a later batch", *batchID)
	}
}
