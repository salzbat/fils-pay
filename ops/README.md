# ops/

Local development stack for FilsPay: Postgres plus the three services that
talk to it directly (apps/api, apps/settlement, apps/reporting). The hosted
demo instance uses the same compose file with a different `.env`.

## Quick start

```
docker compose -f ops/docker-compose.yml up -d postgres
docker compose -f ops/docker-compose.yml run --rm migrate
docker compose -f ops/docker-compose.yml run --rm seed
docker compose -f ops/docker-compose.yml up api settlement reporting
```

apps/web and apps/admin aren't part of this compose file — they're plain
Vite dev servers that talk to apps/api over HTTP (`npm run dev` inside
each package), not services with their own database connection.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | the stack |
| `.env.docker` | shared service settings, loaded by compose for every service |
| `Dockerfile.node` | image for api, reporting, migrate and seed (`node:20`, full install) |
| `Dockerfile.go` | multi-stage build of `apps/settlement` |

> **AM (July):** the two Dockerfiles aren't in the repo for me. built my own
>
> **MK:** they were in the initial ops commit. check you're on main

## Database

- **TLS everywhere.** Postgres runs with `ssl=on`. `postgres/pg_hba.conf`
  accepts network connections only over TLS (`hostssl`) and rejects plain
  ones. Every service connects with `sslmode=verify-full` against the local
  CA. Generate the CA and server cert once with `./postgres/gen-certs.sh`
  (written to `postgres/certs/`, gitignored).
- **One role per service.** `filspay_api`, `filspay_settlement` and
  `filspay_reporting`, with grants in
  `db/migrations/0079_service_roles.sql`. The reporting role can write only its
  rollups; no service can TRUNCATE the ledger. `migrate` and `seed` use the
  owner role `filspay`. On a fresh volume, `postgres/init-roles.sh` creates
  the logins. On an existing volume, run the `ALTER ROLE … LOGIN PASSWORD` step
  once (docs/BUGFIXES.md #50).
- **Secrets** (all DB passwords, the internal token, the webhook key) live in
  `ops/.env`, which is gitignored. Compose does not read `ops/.env.docker`.
- The seed TRUNCATEs its fixture tables: never point it at a shared database.

## Required settings per service

| Service | Needs | Where it comes from in compose |
|---|---|---|
| api | `DATABASE_URL`, `SETTLEMENT_INTERNAL_URL` | `environment:` |
| api | `WEBHOOK_SECRET_ENCRYPTION_KEY` | only outside dev; a dev key is used otherwise |
| api | `ACQUIRER_CALLBACK_SIGNING_SECRET`, `NODE_ENV` | `.env.docker` |
| settlement | `DATABASE_URL` | `environment:` |
| settlement | `SETTLEMENT_INTERNAL_TOKEN` | defaults to `dev-token` |
| reporting | `DATABASE_URL` | `environment:`; runs `worker` by default |

> **MK:** the api won't boot without WEBHOOK_SECRET_ENCRYPTION_KEY in any environment. set it on the hosted box.

## Resource sizing

The hosted demo box is 0.5 vCPU / 2 GB RAM / 2 GB disk; the API container is
limited to 512 MB. Postgres defaults are fine at this size. The settlement
image is built on the box with `go build` from `Dockerfile.go`.

> **AM:** first build on the box filled the disk (go build cache). cleared it and it went through on the second try
