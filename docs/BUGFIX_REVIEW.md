# Bug Fix Review

Static review of the 50 entries in `docs/BUGFIXES.md`. No tests were executed; statuses and fixes below are based on code inspection.

## Status Legend

- **Fixed** — root cause addressed in the working tree.
- **Partially Fixed** — primary issue addressed, but a meaningful gap or operational follow-up remains.

## Summary Table

| # | Bug / Area | Status | Assessment | Suggested Fix |
|---|---|---|---|---|
| 1 | Deployment images | Fixed | Dockerfiles exist; `Dockerfile.node` copies source before dependency installation, which hurts cache efficiency. | Copy only package manifests first, run `npm ci`, then copy source. Add image build smoke tests. |
| 2 | Migration 0054 | Fixed | Invalid view references were removed; unused `merchant_payable_position` still uses gross scheme amounts. | Replace in-place edits with new corrective migrations. Fix or remove the unused view. |
| 3 | Suspense accounts | Fixed | `0055` inserts the missing asset accounts. | Add a chart-of-accounts verification query to the migration or startup check. |
| 4 | Ops env wiring | Partially Fixed | Required vars fail loudly, but `.env.docker` is not loaded, `NODE_ENV` is not passed to `api`, and callback signing config is incomplete. | Add `env_file`, set `NODE_ENV=production`, pass callback secret/require flag, and correct `ops/README.md`. |
| 5 | Compose ordering | Fixed | Healthchecks and dependency ordering were added. | Add a startup integration check that verifies DB readiness after `depends_on`. |
| 6 | Vite proxy | Fixed | Proxies were added; configuration requires empty `VITE_*_API_BASE_URL`. | Document the required empty base URLs and add a dev startup check. |
| 7 | OTP bypass | Fixed | OTP bypass behavior is gated to test configuration. | Add a production-config assertion that refuses to start with bypass enabled. |
| 8 | Cookie security | Partially Fixed | Code honors `NODE_ENV`, but compose does not set it, so production cookie flags may not apply. | Set `NODE_ENV=production` in compose and add a startup check for secure cookies. |
| 9 | Hold expiry | Partially Fixed | Empty-delete guards were added; the job still deletes rows instead of marking them expired and does not re-check status. | Update to `status = 'expired'` with a guarded `WHERE` clause and re-check status before updating. |
| 10 | BHD parsing | Fixed | Uses `parseBhdToFils`; locked tests still assert the old 10x behavior. | Obtain sign-off to update the frozen tests, or version the old behavior. Add finance-approved regression cases. |
| 11 | Balance rebuild | Partially Fixed | Admin path now calls `RebuildAllBalances`; concurrent increments can still be overwritten. | Use a per-merchant advisory lock or rebuild from the ledger under a global lock. |
| 12 | Payment-link concurrency | Partially Fixed | Claim/fencing race fixed; crash-after-claim, open authorization, and post-capture discount failure remain. | Add a `capturing` state with lease and idempotency key; reconcile stale claims; void on failure; make discount adjustment atomic or compensating. |
| 13 | Refund scoping | Fixed | Merchant filter added; acquirer call inside the DB transaction remains a rollback/idempotency risk. | Persist an idempotency record before the acquirer call or use a state machine with reconciliation. |
| 14 | Scheme precision | Fixed | New exports store exact 2dp amounts; historic rounded rows need finance remediation. | Backfill historical `amount` values from `amount_fils` with finance approval and an audit trail. |
| 15 | Rounding residue | Fixed | Journal legs match ADR-0002; historic rows still need reconciliation. | Reconcile historical residue entries and document the accounting treatment. |
| 16 | Net payout | Fixed | Integer subtraction is used. | Add property-based tests for negative, zero, and large payouts. |
| 17 | Split rounding | Fixed | Largest-remainder allocation is correct for non-negative payouts; negative-net payout remains an edge case. | Reject negative net payouts or explicitly generate credit legs; validate weights are non-negative. |
| 18 | Status recompute | Fixed | Only `closed` candidates are selected; `paid` is never recomputed. | Add a regression test covering `paid` and `authorized` rows. |
| 19 | Business-day window | Fixed | UTC-based window and scheduler logic were corrected. | Add DST-boundary and month-boundary tests. |
| 20 | Cancel scoping | Fixed | Cancel is merchant-scoped. | Add an authorization test for cross-merchant cancellation. |
| 21 | Reporting auth | Fixed | Scope/auth guard was added. | Add tests for cross-tenant reporting access. |
| 22 | API-key rotation | Fixed | Old key is revoked; locked test asserts old behavior. | Obtain sign-off to update the frozen test; add rotation audit assertions. |
| 23 | Impersonation | Fixed | Read-only support mapping and active-admin check are present. | Add tests for write attempts during impersonation and inactive admins. |
| 24 | Acquirer callbacks | Partially Fixed | Dedupe, outcome validation, and constant-time compare are present; raw-body HMAC and timestamp freshness are missing. | Verify HMAC over raw bytes, enforce a timestamp/nonce window, and add replay-cache tests. |
| 25 | Webhook signing | Fixed | Dispatcher and test-send sign and send the same canonical string. | Add a shared signing helper test to prevent drift. |
| 26 | Link expiry | Fixed | Server clock is used. | Add tests for clock skew and boundary expiry. |
| 27 | Credit attribution | Fixed | Compares `adminUserId`. | Add audit-log regression tests for display-name collisions. |
| 28 | Payout idempotency | Fixed | Unique indexes and `ON CONFLICT` are present; existing duplicate data blocks migration. | Preflight and dedupe production rows before applying `0074`. |
| 29 | OTP attempts | Fixed | Attempts are spent atomically. | Add concurrent-request tests for the attempt limit. |
| 30 | Transaction recompute | Fixed | Excludes `authorized` and `voided`; `reconcileSandboxFlag` appears unused. | Remove or wire the unused flag and add recompute tests for all statuses. |
| 31 | Platform counter | Fixed | BIGINT/int64 is used; row id=1 assumption remains. | Use an upsert or seed the stats row explicitly and handle missing rows. |
| 32 | Fee effective date | Fixed | Uses `effective_from`; locked test conflict remains. | Obtain sign-off to update the frozen test and add boundary-date cases. |
| 33 | Cancel/capture race | Partially Fixed | Cancel scoping is fixed; late-capture route behavior is not fully verified. | Add a state transition guard so cancelled links cannot be captured, and test the race. |
| 34 | Payout estimate | Partially Fixed | Lifetime estimate was widened; monthly estimate still uses `float32` for monitoring. | Widen the monthly accumulator to `int64` as well. |
| 35 | Payout sweep | Fixed | Guard prevents double-posting; all-or-nothing behavior and no dry-run remain operational limits. | Add per-merchant resumability and a dry-run mode. |
| 36 | Reporting cursor | Partially Fixed | Lock and missing-rollup handling are fixed; serial-id cursor can skip out-of-order commits. | Mark outbox rows processed with `FOR UPDATE SKIP LOCKED`, or use a commit-order-safe watermark. |
| 37 | Bulk KYC | Fixed | Adds the `onboarding_status = 'under_review'` predicate. | Add tests for already-approved and rejected merchants. |
| 38 | CSV export | Fixed | Streaming keyset export was added. | Add large-result and interrupted-download tests. |
| 39 | SSRF | Partially Fixed | Guard exists; trailing-dot, IPv4-mapped IPv6, CGNAT, reserved ranges, and DNS rebinding remain. | Resolve and validate at connect time, normalize hosts, re-check redirects, and consider an egress allowlist/proxy. |
| 40 | Webhook replay | Partially Fixed | Stable id is fixed; no unique constraint on `delivery_event_id`; locked test conflict. | Add a unique constraint and obtain sign-off to update the frozen test. |
| 41 | Ledger immutability | Fixed | Update/delete trigger exists; TRUNCATE is not covered but is not granted to services. | Add a TRUNCATE guard or event trigger and an audit check. |
| 42 | Reporting export auth | Fixed | Auth guard was added. | Add cross-tenant export tests. |
| 43 | Refund summary | Partially Fixed | Join is fixed; view is never refreshed in production and multi-refund days over-count. | Refresh on writes or use a normal view; aggregate `SUM(r.amount_fils)` per refund. |
| 44 | Dev fallback key | Fixed | The fallback key is valid. | Add a production assertion that the dev key is not in use. |
| 45 | OTP exposure | Fixed | Test-only default is used; explicit production `true` can still expose. | Force it off in production or require an explicit break-glass flag. |
| 46 | Fee reconciliation | Fixed | Integer formula is used. | Add rounding property tests against finance vectors. |
| 47 | Session rotation | Partially Fixed | Admin OTP rotates the token; merchant OTP still does not. | Rotate merchant session tokens and reissue cookies on OTP verification. |
| 48 | Secret hygiene | Partially Fixed | Secret was removed from the tracked file; git history leaked it and rotation is required. | Rotate the secret, purge history if required, add CI secret scanning, and exclude `.env` files from images. |
| 49 | Postgres TLS | Partially Fixed | `hostssl`/`verify-full` are configured; certs and keys can be baked into image layers. | Exclude `ops/postgres/certs` from the build context and mount certs at runtime. |
| 50 | Service roles | Partially Fixed | Grants were added; existing volumes need manual role setup and reporting can truncate rollups. | Add an ops migration for existing volumes, remove `TRUNCATE` from reporting, and use separate migrator/service roles. |

## Overall Recommendation

Do not merge yet.

Primary blockers:

- Locked tests `#10`, `#22`, `#32`, and `#40` still assert old buggy behavior and require explicit sign-off to update.
- `.dockerignore` can bake `ops/.env` and TLS private keys into image layers.
- Compose does not set `NODE_ENV` or load `.env.docker`, and callback signing configuration is incomplete.
- Migrations `0074`/`0075` require production duplicate cleanup; `0054`/`0055` were edited in place without checksums.
- Remaining partial fixes: SSRF, payment-link failure modes, reporting cursor, refund summary refresh/over-count, merchant token rotation, and callback raw-body verification.
