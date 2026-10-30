package scheduler

import (
	"testing"
	"time"
)

// docs/BUGFIXES.md: the daily close ran at ~03:15 Bahrain instead of 00:15.
func TestBusinessDayDue_FifteenMinutesAfterBahrainMidnight(t *testing.T) {
	// 2026-10-29 00:20 Bahrain = 2026-10-28 21:20 UTC.
	now := time.Date(2026, 10, 28, 21, 20, 0, 0, time.UTC)
	todayStart, dueAt := businessDayDue(now, 15)

	if want := time.Date(2026, 10, 28, 21, 0, 0, 0, time.UTC); !todayStart.Equal(want) {
		t.Fatalf("todayStart = %s, want %s (Bahrain midnight of the 29th)", todayStart, want)
	}
	if want := time.Date(2026, 10, 28, 21, 15, 0, 0, time.UTC); !dueAt.Equal(want) {
		t.Fatalf("dueAt = %s, want %s (00:15 Bahrain)", dueAt, want)
	}
	if now.Before(dueAt) {
		t.Fatal("at 00:20 Bahrain the previous day should already be due")
	}
}
