package internalapi

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// docs/BUGFIXES.md #11: the admin rebuild must produce the same figure as the
// CLI (the merchant_payable ledger walk), not lifetime scheme-export gross.
func TestRebuildBalances_UsesLedgerNotSchemeLines(t *testing.T) {
	pool := mustPool(t)
	server := newTestServer(t, pool)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool)
	group := uuid.New()
	// capture 10.000 BD gross, 0.250 BD fee, then a 9.750 BD payout -> payable 0.
	if _, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at)
		VALUES ($1, $2, 'card_scheme_clearing', 'debit', 10000, now()),
		       ($1, $2, 'merchant_payable',     'credit', 10000, now()),
		       ($1, $2, 'merchant_payable',     'debit',    250, now()),
		       ($1, $2, 'platform_fee_revenue', 'credit',   250, now()),
		       ($1, $2, 'merchant_payable',     'debit',   9750, now()),
		       ($1, $2, 'platform_cash',        'credit',  9750, now())
	`, group, merchantID); err != nil {
		t.Fatalf("seed ledger: %v", err)
	}
	var batchID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
		VALUES ($1, '2026-04-13', 'paid', 10000, 250, 9750, now(), now()) RETURNING id
	`, merchantID).Scan(&batchID); err != nil {
		t.Fatalf("seed batch: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO scheme_export_lines (settlement_batch_id, amount_fils, line_sequence) VALUES ($1, 10000, 1)
	`, batchID); err != nil {
		t.Fatalf("seed scheme line: %v", err)
	}

	resp := post(t, server, "/internal/rebuild-balances", "Bearer "+testToken, "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var diffs map[string]rebuildDiffResponse
	decodeJSON(t, resp, &diffs)
	if got := diffs[merchantID.String()].After; got != 0 {
		t.Fatalf("after = %d, want 0 (ledger payable after payout), not the 10000 scheme gross", got)
	}
}
