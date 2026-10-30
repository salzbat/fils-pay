-- lifetime_net_payout_monitoring_estimate was REAL (float32, ~7 significant
-- digits) and was bumped with float32 adds in PayoutBatch, so it drifted for
-- high-volume merchants ("lifetime payout estimate drifts"). Integer fils, like
-- every other money value (ADR-0001). Existing values are rounded to whole fils.
ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
    USING round(lifetime_net_payout_monitoring_estimate)::bigint;
