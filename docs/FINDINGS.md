# FilsPay audit — findings report

October 2026. 65 problems found and fixed, plus the open findings listed at
the end. For every fixed problem, `docs/BUGFIXES.md` has the full entry:
what is wrong and why, what it breaks, how it was fixed, why the fix is
small, and how it was verified. This report gives the overview: the root
cause behind each problem, grouped by cause, because most of them come from
a handful of repeated mistakes.

## Summary

- **65 problems found and fixed** (#1–#65 in `docs/BUGFIXES.md`), plus **15
  open findings** (end of this report).
- **The worst:**
  - login without the second factor, or into another merchant's account
    (#7, #8);
  - a payment link charging two cards (#12);
  - refunded sales paid out in full (#58);
  - every redeploy wiping the database (#62);
  - TLS keys and passwords baked into images (#53).
- **The blockers:** nothing started out of the box (#1–#6).

## Root causes

### 1. Authorization checked in one place, not where the data is touched (9)

The route checked *who you are*; the query didn't check *what is yours*.

| # | Problem | Root cause |
|---|---|---|
| 7 | Login without OTP | Session lookup moved to a view that dropped `authenticated = true` |
| 8 | Logged into another merchant | OTP recipient re-looked-up by email across all merchants |
| 13 | Refund any merchant's transaction | Transaction loaded by id only |
| 20 | Cancel another merchant's link | `UPDATE … WHERE id` without `merchant_id` |
| 21 | Read another merchant's report | Split-child check didn't verify the parent |
| 23 | Impersonation could write | Role map gave `owner`; middleware treated as authoritative |
| 27 | Approve your own credit | Compared mutable display names, not ids |
| 37 | Bulk KYC approved rejected merchants | No status predicate |
| 42 | Unauthenticated export endpoint | Missing `preHandler` |

### 2. Check-then-act races and missing idempotency (8)

Two requests both read "nothing happened yet", then both act.

| # | Problem | Root cause |
|---|---|---|
| 12 | Payment link charged two cards | Reservation expired during a slow capture; finalize lost the race, still returned 200 |
| 13 | Concurrent refunds both paid | Validate and write in separate transactions, no row lock |
| 24 | Duplicate callback notes | No unique key on `callback_id` |
| 28 | Duplicate payouts / notifications | NOT EXISTS then INSERT; no unique index |
| 29 | OTP brute force past the limit | Attempt counted after checking the code |
| 35 | Sweep script doubled residue | Random group id per run, no existence check |
| 36 | Reporting double-applied events | Cursor read without a lock |
| 56 | Retried refund could refund twice | Drafted handler and drawer minted a new idempotency key per request |

### 3. Money arithmetic: units, floats, rounding, overflow (13)

| # | Problem | Root cause |
|---|---|---|
| 10 | CSV import 10× too small | Parsed with 2 decimals (cents); BHD has 3 |
| 14 | Scheme file paid more than our records | Untruncated float written to `NUMERIC(10,2)`, rounded up |
| 15 | Residue never journaled | ADR-0002 marked implemented, never coded |
| 16 | Net payout drift | float32 BD round-trip |
| 17 | Split payouts lose fils | Per-child rounding, no largest remainder |
| 31 | Tier flips off past 2.1 bn fils | INTEGER counter, int32 in Go |
| 34 | Lifetime estimate drift | `REAL` column, float32 adds |
| 46 | Reconciliation gap | Float fee estimate |
| 51 | Refund summary doubled captures | Summed per refund, not per transaction |
| 55 | Settlement summary 38% high | Running total summed once per capture event |
| 57 | Discounted refunds over-reversed fee | Ignored the discount-rebate debit |
| 58 | Refunded sales paid out in full | Batch close never netted refunds |
| 60 | Reconciliation gap on refund days | Pending ignored refunds |

### 4. Time zones (2)

| # | Problem | Root cause |
|---|---|---|
| 19 | Daily close at 03:15, not 00:15 | Scheduler passed a UTC date to a Bahrain-day function |
| 59 | Refunds on the wrong reporting day | Drafted rollup bucketed by UTC date |

### 5. Trusting client input (4)

| # | Problem | Root cause |
|---|---|---|
| 26 | Expired link still payable | Expiry compared to client-sent `submittedAt` |
| 39, 52 | Webhook SSRF | Only https checked; then trailing-dot / IPv4-mapped / CGNAT bypasses |
| 56 | Body could pick the merchant | Drafted handler spread the body after the auth merchant |

### 6. Secrets and transport (8)

| # | Problem | Root cause |
|---|---|---|
| 22 | Rotated API key still worked | Rotation never revoked the old key |
| 25 | Merchants couldn't verify signatures | Signed sorted JSON, sent unsorted |
| 44 | Dev key invalid | Constant decoded to 34 bytes |
| 45 | OTP returned in API response | Default on whenever `NODE_ENV` ≠ production |
| 47, 54 | Session fixation (admin, merchant) | Token not rotated at OTP verify |
| 48 | Secret in git | `.env.docker` tracked; "gitignored" claim was wrong |
| 49 | DB traffic unencrypted | `sslmode=disable` |
| 53 | Keys and passwords in images | `COPY . .` with no ignore rules |

### 7. Destructive operations without guards (5)

| # | Problem | Root cause |
|---|---|---|
| 9 | Hold cleanup deleted every hold | Empty id list dropped the WHERE clause |
| 11 | Rebuild button wrote wrong balances | Read gross scheme volume, not the ledger |
| 18 | MDR recalc rewrote paid batches | `status <> 'open'` includes `paid` |
| 30 | Test merchants went live | Counted open auths in a loop that excluded them |
| 41 | Ledger rows editable | Balance trigger allows balanced edits |
| 62 | Every deploy wiped the database | Seed TRUNCATEs and ran on every `docker compose up` |

### 8. Features half-built, wired, or never wired (9)

| # | Problem | Root cause |
|---|---|---|
| 1–6 | Stack can't start | Dockerfiles never committed, migrations reference missing tables, env not passed, no ordering, CORS |
| 33 | Payment links never got the discount | Rebate only in the API capture route |
| 38 | CSV export OOM | Changelog said streaming; code buffered |
| 40 | Replays got new delivery ids | Contradicted the documented dedupe key |
| 43 | Refund summary always empty | Joined refund id to transaction id |
| 50 | Every service was DB superuser | Roles planned, never created |
| 59 | `refund.succeeded` never delivered or reported | Type declared; dispatcher, envelope, consumer never updated |
| 61 | Transaction page crashed on refunds | Formatter rejected negative amounts |

### 9. Documentation and AI answers treated as facts

Not a bug class of its own, but behind many of the above. A changelog,
RUNBOOK, postmortem, handover note or AI answer said something was done or
safe, and nobody checked:
- **Claimed done or fixed:** ADR-0002 "implemented" (#15), FP-201/202
  "fixed" (#12, #24), "the export streams" (#38), "a second run is a no-op"
  (#35), "the button and the CLI do the same thing" (#11).
- **AI answers:** "the dispatcher handles it (per claude)" (#59), "a timing
  difference" (#55), and "`.env` matches `.env.docker` (per copilot)" (#48).

The original `CLAUDE.md` / `AGENTS.md` / `.cursorrules` encoded 13 such
false rules; they are rewritten and the false ones listed in `CLAUDE.md`.

## Hosting and capacity findings

| # | Problem | Root cause | Fix |
|---|---|---|---|
| 62 | Seed wiped the database on every `up` | One-off fixture job ran on every start | Seed skips a non-empty DB (`SEED_RESET=true` to force) |
| 63 | Stack didn't restart, had no limits, Postgres public, no TLS | Compose was dev-only | `restart: unless-stopped`, CPU/memory caps, internal Postgres, nginx TLS proxy |
| 64 | Overload queued until timeout or OOM | No load shedding or timeouts | In-flight cap → 503 + Retry-After, request and pool timeouts, per-IP limits |
| 65 | Nobody could log in to a production stack | OTP codes are never delivered when `NODE_ENV=production` (no email/SMS channel) | `OTP_LOG_CODES` opt-in for the hosted demo |

Details: `docs/HOSTING.md`, `docs/CAPACITY.md`.

## Open findings (not fixed)

| Area | Finding | Why not fixed / next step |
|---|---|---|
| Payment links | A crash between taking the link and capturing leaves it stuck as paid with no capture (#12) | Needs a `capturing` state with a lease and a reconciler, not a small fix |
| Balances | Rebuild button during live traffic can overwrite concurrent updates (#11) | Advisory lock per merchant; make the button async |
| Callbacks | No raw-body HMAC or timestamp freshness (#24) | Would break locked tests with fixed 2025 timestamps |
| SSRF | DNS names that resolve to private IPs (#39, #52) | Needs resolve-time pinning or an egress proxy |
| Refund status | Finance rules conflict for partially captured sales (`refundState.ts`) | Finance decision (July vs September note) |
| API keys | API keys skip every role check | Documented design choice; consider scoped keys |
| Discounts | Rebate posted in a separate transaction after capture (#33) | Fold into capture's transaction |
| Fee formula | TS capture and Go batch fee differ ≤ 1 fil per event (#33) | Finance to pick one formula |
| MDR recalc | Uses `merchants.mdr_bps`, not the effective-dated schedule (#18) | Same rule as capture |
| Reconciliation | Pending ignores schedule and volume tier (#46) | Same |
| Readiness | `/readyz` never re-checks the DB | Deliberate per comment; hosted health uses `/healthz` |
| Scheme export | Refunds don't appear as scheme lines | Acquirer question |
| Analytics | Volumes endpoint doesn't expose refund counts | Locked test deep-equals the point shape |
| Holds | Cleanup deletes instead of marking `expired` (#9) | HANDOVER describes UPDATE; lower severity |
| Dead code | `recordCaptureMetric` (UTC-bucketed, unused), `auth/users.ts` | Delete |

## UX finding: "View as merchant" leads to a login page — fixed (#68, #69)

**Found during manual testing on 2026-10-30; fixed the same day (see `docs/BUGFIXES.md` #68, #69).**

| | |
|---|---|
| **What the admin sees** | After **View as merchant**, the admin console pauses and says *"Merchant screens are at https://… while the grant lasts"*, with a link to open the merchant dashboard. Following the link shows the **merchant login page**. The admin can't see any merchant screen, which is the whole point of the feature (support looking at a merchant's account). |
| **Root cause** | The grant is a separate cookie (`fp_impersonation`), accepted by `requireMerchantAuth` on the data routes. But the dashboard decides whether anyone is logged in by calling `GET /v1/auth/me`, which uses `requireSession` (merchant login sessions only). `/me` returns 401, so the dashboard shows the login screen. `DashboardAuthContext.tsx` even states "impersonation does not exist in the merchant plane". The two halves were built separately and never connected. |
| **What does work** | The grant itself, and it is safe. From the browser console on `https://localhost`, `GET /v1/transactions` returns **200** and `POST …/void` returns **403 `impersonation_read_only`** (#23 verified). |
| **Impact** | Support can't use the feature. The workaround people will reach for is asking merchants for their passwords, which is worse. |
| **Fix (done)** | Let `/v1/auth/me` accept an impersonation grant (returning the merchant, role `support`, and an `impersonating: true` flag). In the dashboard, show a "Viewing as merchant (read-only)" banner and hide write buttons when the flag is set. The server already rejects the writes. |
| **Also seen** | The banner link read `https://HOST` because `PUBLIC_HOST` was set to a placeholder in `ops/.env`. That was a configuration mistake, not a code bug: set `PUBLIC_HOST` to the real host and rebuild. |

## Finance and operations follow-ups

- Re-post past CSV imports for the 10× difference (#10).
- Reconcile historic scheme overpayments (#14).
- Count the March sweeps already in production; don't re-run the script
  (#35).
- Restore Gamma's `test_mode` and check its batches (#30).
- Remove existing duplicates before migration 0074 on production (#28).
- Rotate the leaked acquirer secret (#48).
- If an image built before #53 was pushed anywhere, regenerate certs and
  rotate passwords.

## Locked tests that assert old bugs

These now fail, correctly. Each needs sign-off to update:
- `adminAdjustmentImport` ×4 (#10)
- `admin` "previous key stays active" (#22)
- `acquirerCallbacks` "accepts an unsigned callback" (#24)
- `currentFeeScheduleDisplay` backfill (#32)
- `webhooks` "new delivery id on replay" (#40)
- `transactions` "POST /v1/refunds returns 501" (#56)
