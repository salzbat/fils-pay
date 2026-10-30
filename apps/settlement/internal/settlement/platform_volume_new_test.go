package settlement

import (
	"context"
	"testing"
)

// docs/BUGFIXES.md: the int32 counter wrapped negative just past the tier
// threshold and switched the tier off again.
func TestPlatformVolume_NoOverflowPastInt32(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = 2100000000 WHERE id = 1`); err != nil {
		t.Fatalf("seed counter: %v", err)
	}
	current, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := RecordPlatformProcessedVolume(ctx, tx, current, 60_000_000); err != nil {
		t.Fatalf("record: %v", err)
	}
	after, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if after != 2_160_000_000 {
		t.Fatalf("counter = %d, want 2160000000", after)
	}
	if VolumeTierMdrBonusBps(after) != 15 {
		t.Fatal("tier switched off above int32 max")
	}
}
