package splits

import (
	"fmt"

	"github.com/filspay/settlement/internal/money"
)

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ChildShares distributes netPayout across children by their weights.
// Shares always sum to netPayout exactly when the weights sum to 10000.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	weights := make([]int64, len(children))
	for i, c := range children {
		weights[i] = c.WeightBps
	}
	return allocateByWeight(netPayout, weights)
}

// validateWeights rejects a split whose weights don't add up to 100%, which
// would otherwise strand or invent fils on every payout.
func validateWeights(weights []int64) error {
	var sum int64
	for _, w := range weights {
		sum += w
	}
	if sum != 10_000 {
		return fmt.Errorf("splits: child weights sum to %d bps, want 10000", sum)
	}
	return nil
}

// allocateByWeight is the largest-remainder split (same rule as
// packages/money allocateRemainder): floor each share, then hand the leftover
// fils one at a time to the largest remainders, ties to the lower index.
func allocateByWeight(total money.Fils, weightsBps []int64) []money.Fils {
	shares := make([]money.Fils, len(weightsBps))
	remainders := make([]int64, len(weightsBps))
	var allocated money.Fils
	for i, w := range weightsBps {
		product := int64(total) * w
		shares[i] = money.Fils(product / 10_000)
		remainders[i] = product % 10_000
		allocated += shares[i]
	}
	for leftover := total - allocated; leftover > 0; leftover-- {
		best := -1
		for i, r := range remainders {
			if best == -1 || r > remainders[best] {
				best = i
			}
		}
		shares[best]++
		remainders[best] = -1
	}
	return shares
}
