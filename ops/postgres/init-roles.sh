#!/bin/sh
# Runs once, on a fresh data volume (docker-entrypoint-initdb.d). Creates one
# login role per service so a leaked service credential is not the owner of
# the whole database. Table grants are in db/migrations/0079_service_roles.sql
# (tables don't exist yet at this point).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v api_pw="$FILSPAY_API_DB_PASSWORD" \
  -v settlement_pw="$FILSPAY_SETTLEMENT_DB_PASSWORD" \
  -v reporting_pw="$FILSPAY_REPORTING_DB_PASSWORD" <<'SQL'
CREATE ROLE filspay_api        LOGIN PASSWORD :'api_pw';
CREATE ROLE filspay_settlement LOGIN PASSWORD :'settlement_pw';
CREATE ROLE filspay_reporting  LOGIN PASSWORD :'reporting_pw';
SQL
