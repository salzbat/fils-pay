-- platform_stats.total_processed_fils was INTEGER (max 2,147,483,647 fils =
-- 2,147,483.647 BD). The volume-tier threshold is 2,000,000,000 fils, so the
-- counter overflowed just past it (Go wrapped it negative, switching the tier
-- off again). Money columns are BIGINT everywhere else (ADR-0001).
ALTER TABLE platform_stats
    ALTER COLUMN total_processed_fils TYPE BIGINT;
