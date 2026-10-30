-- FP-212: refunds are netted into the merchant's settlement batch. A refund
-- already moved merchant_payable by -(amount - fee reversed) when it was
-- journaled; without netting, CloseBatch paid the refunded sale out anyway.
--
-- refunds.settlement_batch_id (0042, with idx_refunds_merchant_unbatched)
-- marks a refund as consumed by a batch. The batch keeps the netted totals
-- next to gross/fee so net_payout_fils = gross - fee - refunded +
-- fee_reversed stays explainable.
ALTER TABLE settlement_batches
    ADD COLUMN refunded_fils     BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN fee_reversed_fils BIGINT NOT NULL DEFAULT 0;

-- The reporting rollup for refund.succeeded (apps/reporting applyEvent).
ALTER TABLE merchant_daily_volume
    ADD COLUMN refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN refund_gross_fils BIGINT  NOT NULL DEFAULT 0;
