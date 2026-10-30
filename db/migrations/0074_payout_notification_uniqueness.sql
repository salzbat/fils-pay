-- One settlement.paid event and one disbursement record per batch.
--
-- EnqueuePayoutNotifications (daemon and CLI) checked NOT EXISTS and then
-- inserted, so two runs at once could both insert. The dispatcher recorded a
-- disbursement for every settlement.paid delivery row with attempt_count = 0:
-- once per endpoint, again after a thrown attempt, and again on every replay.
-- Incident 2026-08-21's "two disbursement records" came from these paths.
--
-- If production already holds duplicates (it does, for the 20 Aug batch),
-- these CREATE INDEX statements fail until finance has reviewed and removed
-- the extra rows. That is deliberate: duplicates must not be deleted
-- automatically.
CREATE UNIQUE INDEX uq_outbox_settlement_paid_per_batch
    ON outbox_events (aggregate_id)
    WHERE event_type = 'settlement.paid';

CREATE UNIQUE INDEX uq_settlement_payout_disbursements_batch
    ON settlement_payout_disbursements (settlement_batch_id);
