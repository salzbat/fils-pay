package splits

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// docs/BUGFIXES.md: per-child rounding lost or invented fils on 3-way splits.
func TestChildShares_ThirdsSumExactly(t *testing.T) {
	children := []ChildWeight{{3333}, {3333}, {3334}}
	for _, net := range []money.Fils{4631, 1_000_001, 2_345_679, 1, 0} {
		var total money.Fils
		for _, s := range ChildShares(net, children) {
			if s < 0 {
				t.Fatalf("negative share for net %d", net)
			}
			total += s
		}
		if total != net {
			t.Errorf("net %d: shares sum to %d", net, total)
		}
	}
}

func TestValidateWeights_RejectsNon100Percent(t *testing.T) {
	if err := validateWeights([]int64{5000, 4000}); err == nil {
		t.Fatal("weights summing to 9000 bps were accepted")
	}
	if err := validateWeights([]int64{5000, 5000}); err != nil {
		t.Fatalf("valid weights rejected: %v", err)
	}
}
