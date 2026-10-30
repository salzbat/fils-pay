-- FP-201: acquirer callbacks are redelivered with the same callback_id
-- (stable across retries, per the acquirer comparison). Nothing deduplicated
-- them: there is no processed_events table and no constraint here, despite
-- the postmortem and CHANGELOG 1.6.0/1.9.0. The handler now inserts with
-- ON CONFLICT DO NOTHING against this index.
--
-- Fails if production already holds duplicate callback_ids; review and remove
-- those rows first.
CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback_id
    ON acquirer_callback_notes (callback_id);
