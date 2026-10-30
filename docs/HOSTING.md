# Hosting FilsPay (single server, 1 vCPU / 2 GB)

The whole stack runs from `ops/docker-compose.yml`, the same file used
locally, so a deploy is reproducible from a clean checkout with four
commands.

## Layout

```
internet ──► proxy (nginx, TLS)  :80 → https, :443 dashboard + checkout + /v1, :8443 admin + /v1
               │  per-IP rate limits, timeouts, built web/admin frontends
               ▼
             api (Fastify)  0.5 vCPU / 512 MB, NODE_ENV=production, load shedding
               │
   settlement (Go daemon) ─┤── postgres 16 (TLS only, per-service roles, NOT published)
   reporting (consumer)   ─┘
```

| Service | CPU | Memory | Restarts | Published |
|---|---|---|---|---|
| proxy | 0.15 | 64 MB | unless-stopped | 80, 443, 8443 |
| api | **0.5** | **512 MB** (no swap) | unless-stopped, healthcheck `/healthz` | 127.0.0.1:3000 only |
| postgres | 0.35 | 640 MB | unless-stopped | no |
| settlement | 0.15 | 128 MB | unless-stopped | no |
| reporting | 0.1 | 224 MB | unless-stopped | no |
| migrate, seed | — | — | run once per `up` | no |

Memory caps total about 1.6 GB, which leaves room for the OS on a 2 GB
server. CPU caps are ceilings, not reservations.

## Security controls

- **TLS everywhere.** nginx terminates TLS 1.2/1.3 with HSTS, and http
  redirects to https. API ↔ Postgres uses `verify-full` TLS (#49).
- **Nothing internal is reachable from outside.** Postgres has no published
  port. The api listens on loopback only (for the Vite dev servers).
- **Least privilege.** Each service has its own DB role (#50).
- **Secrets.** Secrets live only in `ops/.env` (gitignored, excluded from
  images, #53). The proxy's TLS key lives in `ops/nginx/tls/` (same
  treatment).
- **Production mode.** The api runs with `NODE_ENV=production`:
  - secure cookies;
  - https-only webhooks with the internal-host guard;
  - no OTP in API responses;
  - it refuses to boot without `SETTLEMENT_INTERNAL_TOKEN` and
    `ACQUIRER_CALLBACK_SIGNING_SECRET`.
- **Overload.** Per-IP rate limits at nginx: 100 r/s on `/v1`, and 10 r/s
  on `/v1/auth` and `/v1/admin/auth`. Beyond those, the api sheds load
  itself (`API_MAX_IN_FLIGHT`, see `docs/CAPACITY.md`).
- **Bounded logs.** Logs rotate at 3 × 10 MB per container.

## Deploy

On the server (Docker Engine with the compose plugin):

```bash
git clone <repo> fils-pay && cd fils-pay/ops

# 1. Postgres TLS (local CA) and the public TLS certificate
./postgres/gen-certs.sh
# Real host: copy the CA-issued cert to nginx/tls/fullchain.pem + privkey.pem.
# Demo without a domain: ./nginx/gen-cert.sh <server-ip-or-name>  (self-signed)

# 2. Secrets: ops/.env (gitignored). Every value must be unique to this host.
cat > .env <<'ENV'
PUBLIC_HOST=<server name or IP>
POSTGRES_PASSWORD=<random>
FILSPAY_API_DB_PASSWORD=<random>
FILSPAY_SETTLEMENT_DB_PASSWORD=<random>
FILSPAY_REPORTING_DB_PASSWORD=<random>
SETTLEMENT_INTERNAL_TOKEN=<random>
WEBHOOK_SECRET_ENCRYPTION_KEY=<base64 of 32 random bytes>
ACQUIRER_CALLBACK_SIGNING_SECRET=<from the acquirer>
SEED_USER_PASSWORD=<random>      # the defaults are public in git
SEED_ADMIN_PASSWORD=<random>
OTP_LOG_CODES=true               # demo only, see below
ENV
chmod 600 .env
#   random value:  openssl rand -hex 32
#   webhook key:   openssl rand -base64 32

# 3. Start
docker compose up --build -d

# 4. Check
docker compose ps                                  # all Up; api (healthy)
curl -k https://<PUBLIC_HOST>/healthz              # {"status":"ok",...}
```

Redeploying is the same `git pull && docker compose up --build -d`. Data
survives a redeploy:
- the volume `filspay_pgdata` persists;
- migrations only apply new files;
- the seed skips a database that already has merchants (#62).

Never set `SEED_RESET=true` on the server: it truncates the ledger.

### OTP delivery on a hosted box

There is no email or SMS integration. With `NODE_ENV=production`, OTP codes
are not delivered anywhere, so nobody can log in (#65). `OTP_LOG_CODES=true`
writes them to the api log (`docker compose logs api | grep otp`). Only
people with shell access to the server can read that log. That is acceptable
for a demo, but **not for real merchants**: replace it with a delivery
channel before go-live.

## Recovery behaviour (verified locally, see `docs/CAPACITY.md`)

| Failure | What happens |
|---|---|
| api process killed or OOM | Docker restarts it; nginx returns 502 for about 3–5 s, then traffic resumes. No committed data is lost: every money write is a single Postgres transaction. |
| Overload | nginx returns 429 per IP over its limit; the api returns 503 + `Retry-After: 1` past its in-flight cap; admitted requests stay fast. |
| Postgres restart | It restarts itself; the api pool reconnects (`pool.on('error')`), and requests during the gap fail fast after the 2 s pool timeout. |
| Server reboot | Every service is `unless-stopped`, so the stack comes back on its own when Docker starts. |

## Dilmune Cloud

Provision one VM of 1 vCPU / 2 GB with Docker. Open only 80, 443 and 8443
in the provider firewall (and 22 for SSH, restricted to the team's IPs).
Then follow "Deploy" above.
