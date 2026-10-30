-- One database role per service instead of every service connecting as the
-- owner (M13). Roles are created NOLOGIN here if missing so this migration is
-- environment-agnostic; each deployment gives them LOGIN and a password
-- (ops/postgres/init-roles.sh does it for compose).
--
-- api, settlement: read/write application data. reporting: read everything,
-- write only its own rollups and cursor. Nobody gets TRUNCATE on the ledger
-- (TRUNCATE would bypass 0077's append-only trigger) or write on
-- schema_migrations. migrate/seed keep using the owner role.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'filspay_api') THEN
        CREATE ROLE filspay_api NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'filspay_settlement') THEN
        CREATE ROLE filspay_settlement NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'filspay_reporting') THEN
        CREATE ROLE filspay_reporting NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO filspay_api, filspay_settlement, filspay_reporting;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO filspay_api, filspay_settlement;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO filspay_reporting;
GRANT INSERT, UPDATE, DELETE ON merchant_daily_volume, merchant_payout_trends, reporting_outbox_cursor
    TO filspay_reporting;
-- Analytics rebuild (admin console in api, `rebuild` CLI in reporting).
GRANT TRUNCATE ON merchant_daily_volume, merchant_payout_trends TO filspay_api, filspay_reporting;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO filspay_api, filspay_settlement, filspay_reporting;

REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM filspay_api, filspay_settlement;

-- Tables created by later migrations (run as the owner) get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO filspay_api, filspay_settlement;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO filspay_reporting;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO filspay_api, filspay_settlement, filspay_reporting;
