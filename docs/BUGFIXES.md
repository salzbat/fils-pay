# Bug fixes

One entry per bug that was found **and** fixed. Each entry says what was
wrong and why, what it broke, and how it was fixed.

> Small fixes that solve the problem are better than long and complex ones.
> Every fix below is the smallest change that makes the failure go away; it
> does not refactor around it.

Bugs that were found but not yet fixed are in the investigation report, not
here.

---

## 1. `docker compose up` fails: the Dockerfiles do not exist

**What is wrong and why.** `ops/docker-compose.yml` builds `api`, `reporting`,
`migrate` and `seed` from `ops/Dockerfile.node`, and `settlement` from
`ops/Dockerfile.go`. Neither file was ever committed on any branch (`git log
--all -- ops/Dockerfile.*` is empty). The compose comment ("pull main again")
and ops/README ("they were in the initial ops commit") are wrong. The 06-02
eng-sync action "Commit Dockerfiles" was never done.

**What it breaks.** The whole local stack and the hosted demo box. The build
stops with `failed to read dockerfile: open Dockerfile.node: no such file or
directory`, so nothing starts.

**How it was fixed.**
- `ops/Dockerfile.node`: `node:20`, copy the repo, `npm ci`. Each service
  already picks its own entrypoint with `command:`, so one image serves all four.
- `ops/Dockerfile.go`: a two-stage `go build ./cmd/settlement` into
  `distroless/static`. The binary already embeds `time/tzdata`, so
  Asia/Bahrain resolves without OS zoneinfo.
- `.dockerignore` (repo root): excludes `node_modules`, so host-built native
  modules (argon2, sharp) are not copied into the Linux image.

Small fix: two short files that match what compose and ops/README already
describe. Compose itself was not restructured.

---

## 2. Fresh database cannot be migrated: `0054_views.sql` references a table that does not exist

**What is wrong and why.** The view `v_unbatched_capture_events` filtered with
`NOT EXISTS (SELECT 1 FROM settlement_batch_events …)`. No migration ever
creates `settlement_batch_events`. Which capture events are batched is
recorded on `transaction_events.settlement_batch_id` (migration 0023), which is
what `CloseBatch` sets. Postgres rejects the view at `CREATE VIEW`, and
`db/migrate.ts` stops at the first failure.

**What it breaks.** `npm run migrate` on any new database stops at 0054 with
only 51 of 66 migrations applied. 0055–0072 never run (credits, adjustment
imports, webhook archives, saved filters, refund defaults), so `seed`, the API
and the tests built on them fail. No new environment, CI database or hosted
instance can be built from `main`.

**How it was fixed.** One predicate:

```sql
WHERE te.event_type IN ('captured', 'partially_captured')
  AND te.settlement_batch_id IS NULL;
```

This is the same "unbatched" test `CloseBatch` uses, and it now also includes
`partially_captured`, which `CloseBatch` settles too. The rest of the file is
unchanged.

Small fix: one WHERE clause swapped for the column that already holds the
fact. No new table, no new migration. The file was edited in place because it
could never have applied as written on any database. *Before merging, confirm
what production actually ran for 0054.*

---

## 3. `0055_chart_of_accounts_suspense.sql` inserts into columns that do not exist

**What is wrong and why.** It inserted `(code, name, account_type,
description)` with `ON CONFLICT (code)`. `chart_of_accounts` (migration 0007)
is `(id, name, kind)` with `kind IN ('asset','liability','revenue')`. The
statement was written against a different schema.

**What it breaks.** Even after bug 2 is fixed, migration stops here
(`column "code" … does not exist`), with the same downstream effect: later
migrations never apply.

**How it was fixed.** The same two accounts, inserted with the real columns:
`(id, name, kind)` with `kind = 'asset'` (suspense accounts are assets, like
`scheme_rounding_residue` in 0007) and `ON CONFLICT (id) DO NOTHING`. The
description text was folded into the name.

Small fix: column names corrected, intent kept. No schema change to
`chart_of_accounts`.

---

## 4. API, seed and settlement refuse to start: required secrets never reach the containers

**What is wrong and why.** Three separate problems combined:
1. Compose sets neither `SETTLEMENT_INTERNAL_TOKEN` nor
   `WEBHOOK_SECRET_ENCRYPTION_KEY`.
2. The compose header says settings come from `ops/.env.docker`
   "automatically". Compose only auto-reads a file named `.env`, and no
   service has `env_file:`, so `.env.docker` is ignored (`docker compose
   config` shows none of its values).
3. The fallback the API is supposed to use in dev
   (`DEV_FALLBACK_WEBHOOK_KEY_B64` in `apps/api/src/config.ts`) decodes to
   `test-key-for-dev-only-not-for-prod`, which is 34 bytes. Validation
   requires exactly 32, so `loadConfig` throws even in development. The
   settlement daemon has no fallback at all (`RequireInternalToken`), despite
   the compose comment claiming it falls back to `dev-token`.

**What it breaks.** The API exits at boot (`must base64-decode to exactly 32
bytes, got 34`). So does the seed, which loads the API config to encrypt
webhook secrets. Settlement exits without its token. The admin plane's calls
to settlement (run batch, rebuild, MDR recalc) cannot authenticate even if
both start.

**How it was fixed.**
- `ops/.env` (gitignored; generated locally, never committed) holds a random
  token and a random 32-byte base64 key.
- `docker-compose.yml` passes them with `${VAR:?set it in ops/.env}`: both to
  `api`, the key to `seed`, the token to `settlement`. A missing value now
  fails loudly at `compose up`, not deep in boot. The false comments next to
  these lines were corrected.

Small fix: five `environment:` lines and a local env file. The 34-byte
fallback in `config.ts` is **not** changed; it is still a bug, but nothing in
compose depends on it any more. Fixing it is a one-line change, left for a
separate entry so `config.ts` changes get their own review.

---

## 5. `seed` and the services can start before `migrate` finishes

**What is wrong and why.** `seed`, `api`, `settlement` and `reporting` waited
only for Postgres to be healthy (`depends_on: postgres: service_healthy`),
not for the migration job. Compose starts them in parallel with `migrate`.

**What it breaks.** On a fresh volume, `seed` (and the services' first
queries) can run against a half-migrated schema and fail. The result depends
on timing.

**How it was fixed.** Dependencies now form a chain: `seed` waits for
`migrate` to exit successfully, and `api`, `settlement` and `reporting` wait
for `seed` (`condition: service_completed_successfully`).

Small fix: only the `depends_on` conditions changed. No wait-for scripts, no
entrypoint wrappers.

---

## 6. Dashboard and admin console cannot call the API from the browser

**What is wrong and why.** `apps/web` and `apps/admin` call
`http://localhost:3000` with `fetch(..., { credentials })` from
`localhost:5173`/`5174`. That is a cross-origin request, and the API registers
no CORS handling, so the browser blocks every call and the session cookie is
never usable.

**What it breaks.** Neither frontend works against the local stack. Login and
every page fail with CORS errors.

**How it was fixed.** A Vite dev proxy (`server.proxy: { "/v1":
"http://localhost:3000" }`) in both `vite.config.ts` files. The frontends are
run with an empty base URL (`VITE_API_BASE_URL=` / `VITE_ADMIN_API_BASE_URL=`),
so requests are same-origin and the proxy forwards them. The API is untouched.

Small fix: one line per config, dev-only. It does not add CORS (and its
cookie/credential security questions) to the API. FH's comment in
`apps/web/vite.config.ts` had already proposed exactly this.

---

## 7. Login works without the OTP code (second factor bypass)

**What is wrong and why.** Merchant login has two steps. `POST /v1/auth/login`
checks the password and sets a *pending* session cookie (`authenticated =
false`), and `POST /v1/auth/otp/verify` promotes it. Every protected route
authenticates through `lookupSession` (`apps/api/src/auth/sessions.ts`), which
read from the view `live_sessions` (migration 0058). That view filters only
`revoked_at IS NULL AND expires_at > now()`; it does not filter on
`authenticated`. So a pending session counted as logged in.

Migration 0012 states the rule explicitly: every auth query must include
`authenticated = true`. The admin equivalent (`lookupAdminSession`) does, and
the merchant one lost it when it was switched to the view.

**What it breaks.** Anyone with a merchant user's password gets full access to
that merchant: transactions, payment links, refunds, webhooks, settlement and
API key management. They never need the OTP. The second factor protects
nothing ("Login works without entering the OTP code?"). Before the fix, a
password-only cookie got **200** on `GET /v1/transactions`. It also makes the
cross-merchant OTP-recipient bug (next on the list) immediately exploitable.

**How it was fixed.** One line added to the `lookupSession` query:

```sql
WHERE s.token_hash = $1
  AND s.authenticated = true
```

Regression test `apps/api/src/auth/sessions.new.test.ts` covers three cases:
- a pending session resolves to `null`;
- a pending cookie gets **401** on `/v1/transactions`, the payment-links list
  and `/v1/auth/me`;
- a promoted session still gets **200**.

The first two fail without the fix and all three pass with it.

Small fix: one predicate in the one function every route already goes
through. The `live_sessions` view was left alone, so nothing else that reads
it changes behaviour. The OTP verify and resend endpoints are unaffected:
they use `lookupPendingSession`, which deliberately matches
`authenticated = false`.

**Verified:** `npm test` gives the same results as before plus the 3 new tests
passing (api 353/365; the 12 failures are the pre-existing refund and
dispatcher ones listed below). `go test ./...` passes. On the running compose
stack, a password-only login followed by `GET /v1/transactions` now returns
**401** (previously 200).

---

## 8. Logging into one merchant can give you another merchant's account

**What is wrong and why.** The same email may exist under several merchants
(`merchant_users` is unique on `(merchant_id, email)`, not on email). Login
looked up the user correctly for the given `merchantId` and checked the
password. It then threw that row away and called
`findOtpRecipient(email)` (`apps/api/src/auth/users.ts`), which searches
**all** active merchants by email with `LIMIT 1` and no ordering. The OTP
challenge and the session were created for whatever row that returned
(`apps/api/src/routes/auth.ts:78`).

**What it breaks.** A user logging into merchant B can end up authenticated
as the same-email user of merchant A, with A's role and A's data, money and
API keys. Which merchant you get depends on physical row order, so it looks
random. Someone who controls the email under one merchant, and knows any
password for that address, can get into another merchant's account. Before
bug #7 was fixed, this needed no OTP at all.

**How it was fixed.** Use the user that was already authenticated:

```ts
const recipient = user;
```

The now-unused `findOtpRecipient` import was removed. Regression test
`apps/api/src/routes/auth.new.test.ts` creates merchants A and B with the same
email (A first), logs into B, and checks that the session row and the OTP
verify response both belong to B. Without the fix, the session belonged to
A's user; with the fix, it passes.

Small fix: one assignment instead of an extra cross-merchant query. Nothing
in the login flow needs the second lookup. `auth/users.ts` is now dead code
and was left in place rather than deleted, to keep this change to one line;
it is safe to delete later.

**Verified:** `npm test`: api 354/366 (the new test passes; the 12 failures
are the same pre-existing refund and dispatcher ones). `go test ./...`
passes. The compose API container was rebuilt with the fix.

---

## 9. The nightly hold cleanup deletes *every* hold when nothing has expired

**What is wrong and why.** `scripts/expire_holds.ts` selects the ids of
expired active holds, then deletes them with `buildDelete("holds", { id:
ids })` (`scripts/lib/sqlFilter.ts`). `buildWhere` silently **skips** empty
arrays, so on a night with no expired holds the filter disappears and the
script runs `DELETE FROM holds` with no WHERE clause (demonstrated: input `[]`
produced `{"text":"DELETE FROM holds"}`). The existing tests only covered one
or more ids.

**What it breaks.** Every hold in the table is wiped, including active holds
on live authorizations, on any quiet night. Holds are the record of reserved
customer funds; losing them breaks void/capture hold release and any
reporting on outstanding authorizations. Nothing can recover them.

**How it was fixed.** Two guards:
- `buildDelete` throws if the WHERE clause comes out empty, so no caller can
  ever issue an unconditional DELETE through it.
- `expire_holds.ts` returns early ("nothing to do") when no ids matched.

New test `scripts/expire_holds.new.test.ts` checks that an empty list and
all-empty filters throw. The existing tests still pass unchanged.

Small fix: two `if` statements, and the generated SQL for real ids is
byte-for-byte the same. Not done here: the script still *deletes* rather than
setting `status = 'expired'` as HANDOVER describes, and it doesn't re-check
status between SELECT and DELETE. Both are lower-severity follow-ups.

---

## 10. CSV adjustment import posts amounts 10× too small and drops the third decimal

**What is wrong and why.** `parseAdjustmentAmountFils`
(`apps/api/src/admin/adjustmentCsvParsing.ts`) used `parseDecimalMinor(raw)`,
whose default is **2** decimal places, i.e. cents. BHD has 3 decimals (1 BD =
1000 fils, ADR-0001), and ADR-0001 requires `parseBhdToFils` for all text
amounts. So `"4.75"` became 475 fils (0.475 BD), and `"4.755"` also became
475 (the third decimal was truncated).

**What it breaks.** Every manual adjustment imported since 1.7.1 posted the
wrong amount to the ledger and the balance cache. Finance's August sheet of
4,141.90 BD posted 414,190 fils = 414.190 BD (Slack, 2026-08-27). This is
the "I uploaded 4.75 BD and it shows 0.475" report.

**How it was fixed.** Use the project's own parser:

```ts
return parseBhdToFils(raw);
```

It reads 2 or 3 decimals correctly and **rejects** more than 3 instead of
truncating. New test `adjustmentCsvParsing.new.test.ts`: `"4.75"`→4750,
`"4.755"`→4755, `"4141.90"`→4,141,900, `"-1.25"`→−1250, `"4.7555"` rejected.

Small fix: one call swapped for the parser ADR-0001 already mandates.

**Note on existing tests.** Four locked tests
(`admin/adjustmentImport.test.ts` ×3, `routes/adminAdjustmentImport.test.ts`
×1) **now fail**. They assert the bug: for example, they expect `"4.75" +
"1.25"` to post 600 fils, when the correct value is 6,000 (6.000 BD). They
were not edited, because the repo forbids changing existing tests without
sign-off. They need updating (600→6000, 500→5000, 475→4750, 125→1250) once
finance confirms. **Follow-up for finance:** past imports must be re-posted for
the difference, using `adjustment_import_rows.raw_amount_text`. There is also
still no guard against importing the same file twice.

---

## 11. Admin "Rebuild cached balances" overwrites balances with the wrong number (FP-203)

**What is wrong and why.** The console button calls settlement's
`/internal/rebuild-balances`, which ran `ledger.RefreshBalanceCache`. That
function reads the view `merchant_payable_position`: lifetime `SUM(
scheme_export_lines.amount_fils)`. That is gross card volume ever exported,
with no fees, payouts, credits, adjustments or refunds subtracted. The CLI
`settlement rebuild-balances` uses `ledger.RebuildAllBalances`, which walks
`ledger_entries`, the real record. CHANGELOG 1.7.0, the RUNBOOK and Slack
all say the two do "the same thing". They don't.

**What it breaks.** Every press of the button replaces every merchant's
balance with a meaningless figure (Alpha Retail dropped from 135K to 7K, then
Yousif fixed it with the CLI). Support then hand-"adjusts" each balance back,
which piles cache-only corrections on top.

**How it was fixed.** The handler now calls `ledger.RebuildAllBalances`, the
same function as the CLI. The response shape is unchanged, so the console
needs no change. New Go test `internalapi/rebuild_source_new_test.go` seeds
a merchant whose ledger nets to 0 after a payout but who has 10,000 fils of
scheme lines, and asserts the button now yields 0, not 10,000.

Small fix: one function call. `RefreshBalanceCache` is now unused and left in
place. ADR-0004 (which chose the faster, wrong source) should be superseded.
If the 40 s ledger walk is too slow for the HTTP timeout, make the button
asynchronous rather than switching back to a wrong source.

---

## 12. A payment link can charge two customers (true cause of incident 2026-05-14)

**What is wrong and why.** `payPaymentLink` (`apps/api/src/paymentLinks/
pay.ts`) works in three steps:
1. It claims the link (`status = 'reserved'`). A reservation older than
   `PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS` (60 s) can be re-claimed by
   anyone.
2. It authorizes and captures with no lock held.
3. It finalizes with `UPDATE … WHERE status = 'reserved'`.

The acquirer sandbox holds 3DS captures for more than 60 s. During that time
a second payer re-claims the link, and both captures go through. The slower
request's finalize then matched 0 rows, and the code still returned **200
"paid"**. The comment at that spot ("this IS reachable") was correct; the
postmortem's callback-dedupe theory was not. All the incident data fits this
race: captures 60–70 s apart, one callback per transaction, and three
captures on FP-PL-8853.

**What it breaks.** Single-use links charge multiple cardholders, and both
are told "payment successful". The bug is still live: the claimed fixes
(FP-201 callback dedupe, FP-202 constraint) do not exist in the code or
schema.

**How it was fixed.** The link is taken **before** capture, fenced on the
caller's own reservation:
- The claim now returns `reserved_at::text` (text, so the microseconds
  survive) as a fencing token.
- After authorize, one conditional UPDATE does `status = 'paid',
  transaction_id = …` `WHERE status = 'reserved' AND reserved_at = <our
  token>`. Exactly one of two competing attempts can win it.
- The loser voids its own authorization (nothing captured yet) and returns
  **409 `payment_link_processing`**.
- The winner captures. If capture fails, the link goes back to `active`.
  The old post-capture finalize and its false "200 paid" fallback are
  removed.
- `VoidInput.actor` now accepts `system`, which `transaction_events` already
  allows.

New test `paymentLinks/pay.new.test.ts` reproduces the incident: payer A
stalls past the timeout, and payer B pays in full meanwhile. Without the fix,
A is told 200 and two cards are captured. With it, B gets 200, A gets 409,
exactly one capture exists, and A's authorization is voided. The existing
payment-link route tests pass.

Small fix: the same three steps, with the finalize moved before capture and
fenced. No new table, lock or connection, and no change to the timeout value.

---

## 13. Refund helper: any merchant could refund any transaction, over the captured amount, twice at once

The route is still a 501 stub, so none of this is live yet. It had to be
fixed before refunds (FP-212) are wired up, because the helper was documented
as "complete, tested".

**What is wrong and why.** In `apps/api/src/payments/processRefund.ts`:
1. **No merchant scoping.** The transaction was loaded by `id` only, and
   `initiateMerchantRefund` passed the *transaction owner's* `merchant_id`
   onward instead of the caller's.
2. **Refundable amount based on authorization, not capture.** `refundable =
   amount_fils − refunded_fils`, so capturing 4.000 BD on a 10.000 BD
   authorization allowed a 10.000 BD refund.
3. **Race.** It validated in one transaction (no `FOR UPDATE`), called the
   acquirer, then wrote `refunded_fils = <stale value> + amount` in a second
   transaction. Two concurrent refunds both passed validation (FP-209).
4. **Every insert failed.** Migration 0070 added `CHECK (reason IS NOT NULL)`,
   and the helper inserted an explicit `NULL`, which bypasses the column
   default. The 11 existing refund tests failed for this reason.
5. **Fee over-reversal.** Each partial refund rounded its fee share on its
   own, so the total reversed could exceed the fee charged.

**What it breaks.** Wired as documented, any merchant could move money out of
another merchant's balance, refund more than was charged, and double-refund
with two simultaneous requests. As shipped, refunds didn't work at all.

**How it was fixed.** One correction per problem, keeping the helper's
structure:
1. `WHERE id = $1 AND merchant_id = $2`. `initiateMerchantRefund` now scopes
   its lookup and passes the caller's merchant.
2. `refundable = captured_fils − refunded_fils`.
3. One transaction with `SELECT … FOR UPDATE`, held across the acquirer call.
   This is the pattern `capture.ts` already uses, so a concurrent refund
   waits, then validates against the committed total.
4. A missing reason is stored as `'unspecified'` (0070's default).
5. The fee reversal is capped at *fee charged − fee already reversed*, and
   the refund that completes the captured amount takes exactly the remainder.

New test `processRefund.new.test.ts`: cross-merchant refund is 404 with no
row written; over-refunding a partial capture is 422; two concurrent full
refunds give exactly one 200 and one 409; three partials reverse exactly the
fee charged. All four fail without the fix and pass with it. The 11
previously failing refund tests now pass too.

Small fix: about 30 changed lines in two files, no new tables. Still needed
before refunds ship (separate work): the route itself, netting refunds into
settlement batches, the `refund.succeeded` webhook (add it to `envelope.ts`
first) and reporting.

---

### Verification for entries 9–13

- `npm run typecheck`: clean.
- `npm test` on a freshly migrated database:
  - money 40/40, events 4/4, web 8/8, reporting 11/11;
  - api **368/373**, previously 354/366: 7 new tests, plus the 11 refund tests
    that now pass.
  - The 5 failures are the 4 locked import tests that assert the 10× bug
    (see #10) and the pre-existing non-deterministic dispatcher backoff test.
- `scripts/*.test.ts`: 7/7.
- `go test ./...`: all packages pass, including the new rebuild test.
- Compose `api` and `settlement` containers rebuilt with the fixes; healthy.

---

# High-severity fixes (#14–#31)

## 14. The scheme file pays the card scheme more than our records say

**What is wrong and why.** `CloseBatch` stored `amount_fils` truncated to 10
fils (correct). But it wrote `amount NUMERIC(10,2)` from the *untruncated*
gross as a float (`SchemeAmountBD(line.grossFils)`), and Postgres **rounds**
on assignment (verified: 93.275 → 93.28). The exported file uses `amount`, so
it disagreed with `amount_fils` on most lines (`docs/exports/scheme/…`: line
1 is 93270 fils but the file says 93.28).

**What it breaks.** "The scheme statement total is always a few fils higher,
never under." The overage is not Visa BIN rounding: we generate the file. The
residue figures and reconciliation are wrong in the other direction.

**How it was fixed.** `amount` is now the truncated value as an exact 2dp
string (`formatFilsAsTwoDecimalString(truncated)`, cast to numeric). New Go
test: 93,275 fils → `amount_fils` 93270 and `amount` "93.27".

Small fix: one argument changed. No schema change. Historic rows still hold
the rounded value; finance should reconcile past overpayments.

## 15. Scheme rounding residue was never journaled (ADR-0002 not implemented)

**What is wrong and why.** ADR-0002 is marked "Accepted, implemented
(CloseBatch, 2026-03)", but `CloseBatch` posted nothing to
`scheme_rounding_residue`. HANDOVER says so plainly.

**What it breaks.** The 0–9 fils per line never reach the scheme and are
recorded nowhere, so the ledger, settlement report and scheme statement
cannot tie out. That is why manual month-end sweeps exist.

**How it was fixed.** In the same loop that writes each scheme line: when
`gross − truncated > 0`, post one balanced group: debit
`scheme_rounding_residue`, credit `card_scheme_clearing`. That is the exact
ADR-0002 table. Covered by the same Go test (5 fils journaled).

Small fix: one conditional INSERT next to the existing one. With #14, the
month-end sweep script is no longer needed for new batches.

## 16. Net payout computed through float32

**What is wrong and why.** `NetPayableFils` converted gross and fee to BD as
`float32` (about 7 significant digits), subtracted, and rounded back.

**What it breaks.** The net payout, the payout ledger leg and the balance
cache drift by several fils on large batches. Measured: +8 fils on a 135k BD
batch.

**How it was fixed.** `return grossFils - feeFils`. New Go test: 135,000,777
− 3,375,019 = 131,625,758 exactly.

Small fix: one line. It also removes a float from a money path, which ADR-0001
calls a review blocker.

## 17. Split payouts don't add up to the parent's net

**What is wrong and why.** `PayoutSplitBatch` gave each child
`ApplyRateFils(net, weight)`, rounding each share on its own (no largest
remainder). Weights were never checked to sum to 10000.

**What it breaks.** Child payouts lose or invent fils every batch: net 4631
over 3333/3333/3334 became 4632; 1,000,001 became 1,000,000. These are Delta
Marketplace's "missing fils". A misconfigured split silently pays out more or
less than the net.

**How it was fixed.** One largest-remainder allocator (`allocateByWeight` in
`splits/shares.go`, the same rule as `packages/money`'s `allocateRemainder`),
used by both `PayoutSplitBatch` and `ChildShares`. Weights must sum to 10000
or the payout errors. New Go tests check that shares always sum exactly and
that bad weights are rejected.

Small fix: one helper replacing per-child rounding. Children still aren't
credited in the ledger individually (`settlement_batch_splits` records them);
that is a design question, not part of this fix.

## 18. "Recalculate MDR" rewrote batches that were already paid out

**What is wrong and why.** `RecalculateMDR` selected `status <> 'open'`,
which includes `paid`, and rewrote `fee_fils`/`net_payout_fils` on those rows.

**What it breaks.** Paid batches' figures change after the bank was told the
amount, so statement, bank instruction and report disagree (Huda's report,
Delta's August batches). ADMIN.md claimed only unpaid batches change.

**How it was fixed.** `AND status = 'closed'`. Paid batches are never
touched. The locked recalc tests (closed batches) still pass.

Small fix: one predicate. Corrections to paid periods need a forward
correction mechanism (out of scope). Not changed: the recalc still uses
`merchants.mdr_bps` rather than the event-time `fee_schedules` rate.

## 19. The daily close ran at ~03:15 Bahrain, not 00:15

**What is wrong and why.** The daemon passed `time.Now().UTC()` to
`BusinessDayWindow`, which takes the calendar date from its argument's own
zone. Between 00:00 and 03:00 Bahrain the UTC date is still yesterday, so the
new day only became due after UTC midnight + 15 min, which is 03:15 local. The
window boundaries themselves were always correct Bahrain days. (`CLAUDE.md`'s
"settlement is UTC" is wrong.)

**What it breaks.** Batches close and payouts go out about 3 hours late every
day ("the daily close is running at 3am local").

**How it was fixed.** New `businessDayDue(now, delay)` reads today's date in
UTC+3 first, then calls `BusinessDayWindow`. New Go test: at 00:20 Bahrain
the previous day is due at 00:15.

Small fix: a 4-line helper in the scheduler. `BusinessDayWindow` is unchanged,
so its locked tests and the CLI path keep working.

## 20. Merchant A could cancel merchant B's payment link

**What is wrong and why.** `DELETE /v1/merchants/:merchantId/payment-links/:id`
checked only that the *path* merchant was the caller. `cancelPaymentLink`
updated by `id` alone.

**What it breaks.** Any merchant can cancel any other merchant's links by id
("I cancelled merchant B's payment link from merchant A's dashboard").

**How it was fixed.** `AND merchant_id = $2` (the authenticated merchant) in
both queries. Another merchant's link is "not found". Test #20 in
`routes/highFixes.new.test.ts`.

Small fix: one predicate and one argument.

## 21. A merchant could read another merchant's transaction report

**What is wrong and why.** `resolveReportMerchantId` allowed
`filter.merchantId` to be *any* merchant that is someone's split child. It
never checked that the caller is that child's parent.

**What it breaks.** Cross-tenant read of transaction reports: any
authenticated merchant can read any split child's report.

**How it was fixed.** `AND parent_merchant_id = $2` (the caller). Test #21.

Small fix: one predicate.

## 22. Admin "Rotate API key" left the old key working

**What is wrong and why.** `rotateApiKeyAsAdmin` issued a new key and audited
it, but never revoked the old one, despite 0037's "one transaction revokes the
old key". There is no grace-period sweeper (0056's `revoke_after` is unused).

**What it breaks.** Rotating a leaked key does nothing: the leaked key keeps
full merchant API access forever ("a key rotation flow that doesn't do what
you'd expect").

**How it was fixed.** `UPDATE api_keys SET revoked_at = now(), revoked_reason
= 'rotated'` in the same transaction. Test #22: the old key no longer
verifies; the new one does.

Small fix: one statement. **Locked test now failing:**
`routes/admin.test.ts` "…the previous key stays active" asserts the bug and
needs updating.

## 23. "View as merchant" gave admins owner/finance write access

**What is wrong and why.** The impersonation role map was `super_admin →
owner` and `finance → finance`. 0035, HANDOVER and the console banner all say
read-only support. Writes made while impersonating were recorded as the
merchant's own session. Grants also kept working after the admin was
disabled.

**What it breaks.** Operators could capture, void, create links and change
webhooks as the merchant, with no trace that it was them.

**How it was fixed.**
- Every admin role maps to `support`.
- `requireMerchantWriterActor`, which every merchant write goes through,
  rejects the `admin_impersonation` actor with `impersonation_read_only`.
- The grant lookup requires `admin_users.status = 'active'`.

Test #23.

Small fix: a role map, one guard, one predicate.

## 24. Acquirer callbacks: unsigned accepted, never deduplicated (FP-201)

**What is wrong and why.**
- `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` defaulted to `false`, so the public
  callback route accepted unsigned requests from anyone, for any transaction.
- An empty signing secret also "verified" (anyone can compute an HMAC keyed
  with `""`).
- The compare used `Buffer.compare`, which is not constant-time.
- `outcome` wasn't validated.
- Nothing deduplicated redeliveries: no `processed_events` table, no
  constraint. The postmortem and CHANGELOG say otherwise.

**What it breaks.** Forged fraud verdicts on any transaction, and duplicate
notes on redelivery (FP-201 reopened).

**How it was fixed.**
- Signatures are required unless explicitly disabled.
- An empty secret never verifies.
- `crypto.timingSafeEqual` does the compare.
- `outcome` must be `cleared` or `confirmed_fraud`.
- Migration 0075 adds a unique index on `callback_id`, and the insert does
  `ON CONFLICT DO NOTHING`.

Test #24.

Small fix: a default, three guards, one index. **Locked test now failing:**
`routes/acquirerCallbacks.test.ts` "accepts a callback sent without a
signature header" asserts the hole. Not done: timestamp freshness and
raw-body HMAC, which would break the locked signed-callback tests that use a
fixed 2025 timestamp.

## 25. Merchants can't verify our webhook signatures (FP-240)

**What is wrong and why.** The dispatcher signed `canonicalJson(payload)`
(sorted keys) but sent `JSON.stringify(payload)`, and `payload` comes from a
JSONB column in Postgres's own key order. Signed bytes ≠ sent bytes. The
"send test event" path had the same mismatch.

**What it breaks.** Receivers that verify over the raw body (the correct way)
reject our deliveries; Beta Digital's 401 "invalid signature" log. The RUNBOOK
told merchants to re-sort keys as a workaround.

**How it was fixed.** Send `canonicalJson(payload)`, exactly the string that
was signed, in both the dispatcher and test-send. This is what YA's deleted
`ya/sign-raw` branch was for. The existing end-to-end dispatcher tests (a real
receiver verifying the signature) pass.

Small fix: one serializer swapped in two places.

## 26. An expired payment link could still be paid (FP-187)

**What is wrong and why.** Expiry was compared to the client-supplied
`submittedAt`, and the checkout page sends it.

**What it breaks.** A buyer could pay an expired link by sending an old
timestamp ("the link showed expired, but the payment still went through").

**How it was fixed.** Expiry uses the server clock only (`new Date()`). The
`expiryReferenceTime` helper and its locked tests are untouched. Test #26: an
expired link with `submittedAt` 2020 → 410.

Small fix: one line.

## 27. A credit requester could approve their own credit

**What is wrong and why.** The two-person check compared `displayName`, which
is mutable and need not be unique, instead of the admin's id (HANDOVER said
"compared by admin user id").

**What it breaks.** Rename yourself and approve your own above-threshold
credit; or two admins who share a name can't approve each other's.

**How it was fixed.** `approver.adminUserId === requester.adminUserId` →
409. Test #27.

Small fix: one comparison. Not changed (needs a product decision): support
admins can still create unlimited ≤ 50 BD credits that post immediately.
ADMIN.md allows "small credits", but there's no count or velocity limit.

## 28. Duplicate payout disbursements and duplicate "your payout is on the way"

**What is wrong and why.**
- `EnqueuePayoutNotifications` did NOT EXISTS then INSERT, so two runs at
  once (daemon + CLI) both inserted. The code comment's "unique index" didn't
  exist.
- The dispatcher recorded a disbursement for every `settlement.paid` delivery
  row with `attempt_count = 0`: once per endpoint, again after a failed
  attempt, and on every replay (replays start at 0).

**What it breaks.** Two `settlement.paid` webhooks and two disbursement
records for one payout (incident 2026-08-21, whose two different outbox ids
fit the enqueue race), plus more on every replay.

**How it was fixed.** Migration 0074 adds unique indexes (one `settlement.paid`
per batch, one disbursement per batch). The Go enqueue uses `ON CONFLICT DO
NOTHING` and counts only real inserts; the disbursement insert uses `ON
CONFLICT DO NOTHING`.

Small fix: two indexes and two `ON CONFLICT` clauses. **On production** the
index creation fails until the existing duplicates are reviewed and removed
by hand. That is deliberate: money records must not be deleted
automatically.

## 29. OTP codes were guessable and brute-forceable

**What is wrong and why.**
- OTP codes and admin invite codes used `Math.random` (predictable from
  output). The admin OTP doc claimed `crypto.randomInt`.
- Attempts were check-then-increment, so 50 parallel guesses all saw 0
  attempts and all got checked. MK's comment that the admin path reads FOR
  UPDATE is false.
- `/otp/resend` reset the guess budget, despite its docstring.

**What it breaks.** The second factor can be brute-forced well past the
5-attempt limit, and an invite code (which creates an admin account) is
predictable.

**How it was fixed.**
- `lib/random.ts` uses `crypto.randomInt`; invite codes use it too.
- The merchant and admin verify paths spend an attempt atomically (`UPDATE …
  WHERE attempt_count < max_attempts RETURNING`) *before* comparing.
- Resend copies the old challenge's `attempt_count`.

Test #29: 20 parallel wrong guesses → at most 5 are checked.

Small fix: one RNG swap, one atomic statement per path, one UPDATE on resend.

## 30. "Recompute transaction statuses" put test merchants into real settlement

**What is wrong and why.** The recompute counted open authorizations inside a
loop over rows that had already *excluded* `authorized`, so the count was
always 0. `reconcileSandboxFlag` then set `test_mode = false` on any test
merchant with any transaction.

**What it breaks.** Test merchants (Gamma, "testModeCleared: true") become
live and their test captures are settled and paid ("test merchants keep
showing up in the real settlement run").

**How it was fixed.** The route no longer calls `reconcileSandboxFlag`
(`flagsUpdated` is always `[]`, so the response shape is kept), and
`openAuthorizations` is counted with its own query.

Small fix: one call removed, one count corrected. Gamma's `test_mode` must be
restored by hand, and its batches checked.

## 31. Platform volume counter overflows just past the tier threshold

**What is wrong and why.** `platform_stats.total_processed_fils` is `INTEGER`
(max 2,147,483,647). The tier threshold is 2,000,000,000. Go read and added
`int32`, which wraps silently.

**What it breaks.** The 0.15% platform discount switches on at 2.0M BD
lifetime volume, then off again about 147k BD later when the counter wraps
negative. Fees flip with no one noticing.

**How it was fixed.** Migration 0073 makes the column `BIGINT`, and the three
Go functions use `int64`. New Go test: 2.1e9 + 6e7 = 2.16e9 and the tier stays
on.

Small fix: one column type, three type changes. Not code: the tier threshold
change has no finance ticket, and HANDOVER said "no until finance signs off".
Confirm before relying on it.

---

### Verification for entries 14–31

- `npm run typecheck`: clean. `go vet ./...`: clean.
- Every new test was run with its fix stashed (it fails) and with the fix (it
  passes).
- `npm test` on a freshly migrated database (69 migrations): money 40/40,
  events 4/4, web 8/8, reporting 11/11, **api 374/381**. The 7 failures:
  - 4 locked import tests asserting the 10× bug (#10);
  - 2 locked tests asserting the vulnerability itself: unsigned callbacks
    accepted (#24), "previous key stays active" (#22);
  - the pre-existing non-deterministic dispatcher backoff test.
- `scripts/*.test.ts` 7/7. `go test ./...`: all packages pass.
- Live compose stack: migrations 0073–0075 applied; `api` and `settlement`
  rebuilt; healthy.

---

# Medium-severity fixes (#32–#46)

## 32. The fee shown for a merchant isn't the fee we charge (245 vs 225 bps)

**What is wrong and why.** `getCurrentFeeScheduleForDisplay` took the newest
`fee_schedules` row by `created_at`. Capture (`feeSchedule.ts`) and settlement
(`fee_schedule.go`) use the newest row whose `effective_from` has arrived. A
backfill (an older period entered later) therefore showed as "current".

**What it breaks.** The displayed rate (245 bps, the backfilled row) differs
from the charged rate (225 bps). Support can't explain merchants' fees.

**How it was fixed.** The query now uses `WHERE effective_from <= now() ORDER
BY effective_from DESC, created_at DESC`, the same rule as the billing paths.
Test #32.

Small fix: one query. **Locked test now failing:**
`fees/currentFeeScheduleDisplay.test.ts` "returns the most recently entered
schedule even when an older period was backfilled later" asserts the bug.

## 33. Payment-link captures never got the merchant's negotiated discount

**What is wrong and why.** The discount rebate
(`applyCaptureDiscountAdjustment`) ran only in the API capture route. The
payment-link flow calls `captureTransaction` directly and never applied it.
A comment claiming it had "moved into capture.ts in July" was false.

**What it breaks.** Discounted merchants pay full MDR on every payment-link
sale, and their ledger payable disagrees with what settlement computes.

**How it was fixed.** `payPaymentLink` calls `applyCaptureDiscountAdjustment`
after a successful capture, exactly as the route does. Its own guard prevents
a double rebate.

Small fix: one call. Not changed: the rebate still runs in its own
transaction after capture, and the API applies the discount after MDR while
Go applies it before (a ≤ 1 fil rounding difference). Unifying the fee
formula is a separate change.

## 34. Lifetime payout estimate drifts for high-volume merchants

**What is wrong and why.** `lifetime_net_payout_monitoring_estimate` was
`REAL` (float32) and was bumped with float32 adds in `PayoutBatch`.

**What it breaks.** It loses precision past about 16.7M fils, so the ops
figure drifts ("lifetime payout estimate drifts for high-volume merchants").

**How it was fixed.** Migration 0076 makes the column `BIGINT` (rounding
existing values), and Go adds `int64`. The locked Go test (expects exactly
51000) passes.

Small fix: a type change in two places.

## 35. The March sweep script doubled the residue when run twice

**What is wrong and why.** `scripts/reconcile_march.ts` posted with a fresh
random `entry_group_id` every run and had no existence check, and it has no
dry-run mode. The RUNBOOK claims "a second run is a no-op"; it wasn't. It
doubled on staging, and FH's "dry run" on 3 July very likely posted a second
sweep in production.

**What it breaks.** Every run posts the whole March residue again.

**How it was fixed.** Before posting, the script checks for any ledger row
with its description and refuses to run if one exists.

Small fix: one guard query. Not changed: its UTC month window and
per-transaction residue maths (see the investigation report). With #14/#15
the script isn't needed for new months. **Do not re-run it**; finance needs
to count how many March sweeps production already holds.

## 36. Reporting: double-applied events, and one missing row stalls everything

**What is wrong and why.**
- The consumer cursor was read without a lock, so a `catch-up` run beside
  the live worker read the same watermark and applied the same events twice.
  The RUNBOOK said this was safe; MK's note said it isn't.
- `applyBatchClosed` dereferenced the rollup row without checking it
  existed. A missing row threw, rolled back the whole pass, and the same
  event failed again every pass, stopping reporting for good.

**What it breaks.** Inflated dashboards, or no dashboard updates at all.

**How it was fixed.**
- `SELECT … FOR UPDATE` on the cursor row, so concurrent consumers
  serialize.
- A missing rollup row is treated as 0 and logged as lag.

The 11 reporting tests pass.

Small fix: `FOR UPDATE` plus an optional chain. Not changed: consuming by
`id` can still skip events that commit out of id order (HANDOVER's unfinished
xid8 item).

## 37. Bulk KYC approve could approve rejected merchants

**What is wrong and why.** `bulkApproveMerchantsKyc` updated every selected
id regardless of status. ADMIN.md says "only merchants currently
under_review are affected".

**What it breaks.** A rejected merchant ticked by mistake becomes approved
and can take payments.

**How it was fixed.** `AND onboarding_status = 'under_review'`. Test #37.

Small fix: one predicate.

## 38. CSV export loaded everything into memory (and the pager skipped rows)

**What is wrong and why.** `GET /v1/transactions/export` built the whole file
in memory with no range limit. CHANGELOG 1.8.0 says it streams; it didn't.
The unused stream variant keyed pages on `occurred_at` alone, so rows sharing
a timestamp at a page edge were skipped.

**What it breaks.** A wide export can OOM the 512 MB API container ("has
anyone tried uploading a really large export?").

**How it was fixed.** The route streams `transactionsExportCsvChunks`, which
pages 1000 rows at a time with an `(occurred_at, id)` keyset (timestamp kept
as text so microseconds survive). Test #38: 1005 rows with the same
timestamp all export.

Small fix: the existing stream function was corrected and wired in; the
in-memory builder is kept for its locked tests.

## 39. Webhook URLs could target internal services (SSRF)

**What is wrong and why.** The only URL check was https in production.
`https://169.254.169.254/`, private IPs and internal names like
`settlement:8091` were accepted, and `fetch` followed redirects, so even a
public URL could bounce a delivery inward.

**What it breaks.** A merchant could make the platform POST to internal
services and cloud metadata endpoints.

**How it was fixed.** In production, reject loopback, private, link-local,
unspecified and single-label hosts. The transport uses `redirect: "manual"`,
so a 3xx is a failed delivery. Test #39.

Small fix: one host check and one fetch option. Not covered: DNS names that
resolve to private IPs (needs resolve-time pinning).

## 40. Replayed webhooks got a new delivery id, so receivers couldn't dedupe

**What is wrong and why.** `insertReplayDeliveryRow` minted a fresh
`delivery_event_id`. ARCHITECTURE §5, `headers.ts` and ADMIN.md all say the
id is stable across retries and replays, because it's the receiver's dedupe
key.

**What it breaks.** Every replay looks like a new event to the merchant:
duplicate order or payout processing on their side.

**How it was fixed.** Reuse the original envelope's `id` (falling back to a
new one only if it's missing).

Small fix: one assignment. **Locked test now failing:**
`routes/webhooks.test.ts` "replay: creates a new row … with a new
delivery_event_id" asserts the bug.

## 41. Ledger entries could be deleted or edited

**What is wrong and why.** 0007 claims rows are immutable because the
balance trigger fires on UPDATE/DELETE. Deleting or editing a whole balanced
group still balances, so it passed (verified).

**What it breaks.** The "record of money movements" can be silently rewritten.

**How it was fixed.** Migration 0077 adds a `BEFORE UPDATE OR DELETE` trigger
that rejects any change: corrections are new entries, as ARCHITECTURE says.
`TRUNCATE` (dev seed) is unaffected, and no application code updates or
deletes ledger rows. Test #41.

Small fix: one trigger.

## 42. `/v1/reporting/export-summary` had no authentication

**What is wrong and why.** The route had no `preHandler` and read
`request.merchantAuth!`.

**What it breaks.** Any unauthenticated caller got a 500 (the merchant
context was undefined). It was an open, crashing endpoint.

**How it was fixed.** `{ preHandler: requireMerchantAuth }`, so it now
returns 401. Test #42.

Small fix: one option.

## 43. Refund summary view joined on the wrong key

**What is wrong and why.** 0072's materialized view joined `t.id = r.id`. A
refund id is never a transaction id.

**What it breaks.** `original_captured_fils` was always empty in the admin
refund dashboard.

**How it was fixed.** Migration 0078 recreates the view joined on
`r.transaction_id`. Test #43.

Small fix: one join condition (via a forward migration, since 0072 may be
applied).

## 44. The API's built-in dev encryption key was invalid (it never booted without one)

**What is wrong and why.** `DEV_FALLBACK_WEBHOOK_KEY_B64` decoded to 34
bytes. The validator requires exactly 32, so the "dev fallback" always threw
(see #4).

**What it breaks.** The API and seed can't start in dev unless a key is set.
The compose comment and ops/README said otherwise.

**How it was fixed.** Replaced with a valid 32-byte dev key
(`filspay-dev-only-webhook-key-32b`). It's still dev-only: production
requires a real key.

Small fix: one constant. Ops items not changed in code: `ops/.env.docker` is
committed with a sandbox secret (rotate it and stop tracking it), a single DB
superuser role, `sslmode=disable`.

## 45. The OTP code was returned in the login response on non-production boxes

**What is wrong and why.** `otpDevExpose` defaulted to true whenever
`NODE_ENV ≠ production`. An unset `NODE_ENV` means "development", and the
FP-209 hosted load test ran that way.

**What it breaks.** On such a host, every login response includes its own
OTP, so the second factor is void even with #7 fixed.

**How it was fixed.** It defaults to true only when `NODE_ENV=test`;
otherwise set `OTP_DEV_EXPOSE=true` explicitly. Dev still logs the code.
Test #45.

Small fix: one default. (On the local compose stack, read the code from
`docker compose logs api`.)

## 46. Reconciliation estimated pending fees with floating point

**What is wrong and why.** `getReconciliationReport` priced unbatched captures
with `estimateFeeFils` (float maths). Its docstring claimed it used the
fee schedule and tier, and relied on a non-existent "0046 trigger".

**What it breaks.** The pending figure could be off by a fil per event,
leaving an "unexplained" gap.

**How it was fixed.** The same integer formula as settlement's
`ComputeSettlementFee`: discount off the amount, then MDR, both via
`applyRateFils`. The docstring was corrected. The locked reconciliation tests
(`gapFils === 0`) pass.

Small fix: two lines. Not changed: the pending estimate still uses
`merchants.mdr_bps`, not the effective-dated schedule or tier.

## 47. Admin session token wasn't rotated at OTP verification (session fixation)

**What is wrong and why.** Admin login sets a pending session cookie. OTP
verify promoted *that same token* to a fully authenticated session and re-set
the identical cookie.

**What it breaks.** Anyone who obtains or plants the pre-OTP cookie (shared
machine, proxy logs, a fixation link) becomes logged in as that admin the
moment the real admin types their code. The YA/MK comments in
`adminAuth/sessions.ts` flagged this as unresolved.

**How it was fixed.** At promotion, `otp/verify` generates a new random token,
stores its hash on the session row in the same transaction, and sets the new
cookie. The pre-OTP token stops working immediately. Test #47 in
`routes/mediumFixes.new.test.ts`: the new cookie differs, the old cookie gets
401 on `/v1/admin/auth/me`, and the new one gets 200.

Small fix: one UPDATE and one cookie value. **This required changing the
login helper in four locked test files** (`routes/admin.test.ts`,
`adminAdjustmentImport.test.ts`, `adminBalanceAdjustments.test.ts`,
`adminCredits.test.ts`), approved by the user. The helpers now use the
cookie that verify sets, as a browser does. No test assertions were changed.
The first attempt without this helper change broke about 60 tests and was
reverted.

## 48. A signing secret was committed to git

**What is wrong and why.** `ops/.env.docker` is tracked in git, and it held the
acquirer callback signing secret. Its comment claimed the file was gitignored;
`.gitignore` only lists `.env`.

**What it breaks.** Anyone with repo access can forge "signed" acquirer
callbacks for that environment.

**How it was fixed.** The value was removed from the tracked file, which now
says where the real value goes (`ops/.env`, gitignored, passed to the api by
compose as `ACQUIRER_CALLBACK_SIGNING_SECRET`).

Small fix: one line. **Still required (outside code):** the old value is in git
history, so it must be **rotated with the acquirer**. Optionally purge it
from history.

## 49. Database connections were unencrypted (`sslmode=disable`)

**What is wrong and why.** Every service connected with `sslmode=disable`. The
ops README argued this was safe because the network never leaves the host,
but the same compose file runs the hosted demo box, and Postgres was
published on port 5432.

**What it breaks.** Credentials and all financial data cross the network in
plain text; anyone on the path can read or alter them.

**How it was fixed.**
- `ops/postgres/gen-certs.sh` creates a local CA and a server cert valid for
  `postgres`/`localhost` (gitignored).
- The Postgres service runs with `ssl=on`. A small entrypoint wrapper puts
  the key in place with the ownership Postgres requires.
- `ops/postgres/pg_hba.conf` allows network logins only via `hostssl` and
  rejects plain ones.
- Every connection string uses `sslmode=verify-full&sslrootcert=/certs/ca.crt`,
  so the certificate is verified, not just encrypted.

Verified live: all service connections show `ssl = t` in `pg_stat_ssl`, and a
`sslmode=disable` connection is rejected ("no encryption").

Small fix: config only, no application code. For a real host, issue the
server cert from that environment's CA instead of the local one.

## 50. Every service connected as the database owner

**What is wrong and why.** api, settlement, reporting, migrate and seed all
used one superuser-owner role (`filspay`). HANDOVER and a compose TODO both
called this unfinished.

**What it breaks.** A bug or leaked credential in any one service can do
anything to any table, including DDL, `TRUNCATE ledger_entries` (which
bypasses #41's trigger), or dropping the database.

**How it was fixed.** Migration 0079 creates `filspay_api`,
`filspay_settlement` and `filspay_reporting` (NOLOGIN if missing, so it's
environment-agnostic) with least-privilege grants:
- api and settlement read/write data;
- reporting reads everything but writes only its two rollups and cursor;
- only the two rollups can be TRUNCATEd (for the analytics rebuild);
- nobody but the owner writes `schema_migrations`;
- default privileges cover future tables.

`ops/postgres/init-roles.sh` gives the roles logins and passwords on a fresh
volume, and compose wires each service to its own role. Passwords are in
`ops/.env`.

Verified:
- The **whole API test suite run as `filspay_api`** passes except tests whose
  *fixtures* do DDL (adding a failure-injecting constraint, refreshing a
  materialized view), which the app never does.
- The **whole Go suite run as `filspay_settlement`** passes.
- Live: each service connects as its own role, and the reporting role gets
  "permission denied" writing `ledger_entries`.

Small fix: one migration, one init script, connection strings. **On an
existing volume** (like the running local stack, or production), run once
after migrating: `ALTER ROLE filspay_api LOGIN PASSWORD '…'` (and the same for
the other two).

---

### Verification for entries 47–50

- Admin login suites (`admin`, `adminAdjustmentImport`,
  `adminBalanceAdjustments`, `adminCredits`) pass with the rotation, apart
  from the known locked tests that assert old bugs.
- `routes/mediumFixes.new.test.ts` 9/9.
- API suite as `filspay_api`, and Go suite as `filspay_settlement`, as above.
- Live stack: Postgres restarted with TLS; migration 0079 applied; role
  logins set; api, settlement and reporting reconnected as their own roles
  over verified TLS. Health 200, merchant login 200, no errors in logs.

---

### Verification for entries 32–46

- `npm run typecheck`: clean.
- New tests `routes/mediumFixes.new.test.ts`: 8/8 pass. With the code fixes
  stashed, 6 of them fail (the others cover migration-only fixes).
- `npm test` on a freshly migrated database (72 migrations): money, events,
  web and reporting all pass; **api 380/389**. The 9 failures:
  - 4 import tests asserting the 10× bug (#10);
  - 4 tests asserting the old vulnerable or buggy behaviour: unsigned
    callbacks (#24), previous key stays active (#22), backfilled fee display
    (#32), new delivery id on replay (#40);
  - the pre-existing non-deterministic dispatcher test.
- `go test ./...`: all packages pass. `scripts/*.test.ts` 7/7.
- Live stack: migrations 0076–0078 applied; `api`, `settlement` and
  `reporting` rebuilt; healthy.

---

### Verification for entries 1–6

- `docker compose up --build -d`: all images build; `migrate` applies 66/66;
  `seed` reports "all REAL assertions passed"; `api`, `settlement` and
  `reporting` stay up. `GET /healthz` and `GET /readyz` return 200, and
  settlement ran `RunDailyBatch(2026-10-28)` for 7 merchants.
- `npm test` on a freshly migrated database: same results as before the
  changes. Money 40/40, events 4/4, web 8/8, reporting 11/11, api 350/362. The
  12 failures are pre-existing and unrelated to these fixes: 11 refund tests
  fail on the 0070 `reason` check, and 1 dispatcher test is non-deterministic
  (backoff jitter).
- `go test ./...` (in `golang:1.22`): all packages pass.

---

# Fixes from the review (`docs/BUGFIX_REVIEW.md`)

## 51. Refund summary counted a capture once per refund

**What is wrong and why.** 0078's `refund_merchant_summary` summed
`t.captured_fils` per *refund* row. A transaction with two partial refunds on
the same business day added its capture twice.

**What it breaks.** `original_captured_fils` in the admin refund dashboard is
inflated for any day with more than one refund on one transaction (a 4.000 BD
capture refunded 1.500 + 2.500 showed 8.000 BD). Refunds are not live yet
(#13), so no production figures are affected.

**How it was fixed.** Migration 0080 rebuilds the view to aggregate refunds
per transaction first, then add each capture once. Column names and types
are unchanged, and 0079's default privileges still grant it to the service
roles. Test #51 in `routes/reviewFixes.new.test.ts`. Checked on the local
database inside a rolled-back transaction: 8000 before, 4000 after.

Small fix: one forward migration. Not changed: nothing refreshes the view yet.
That belongs with wiring up refunds (FP-212), because no code reads it today.

## 52. Webhook URL guard missed trailing-dot names, IPv4-mapped IPv6 and CGNAT

**What is wrong and why.** #39's `isInternalHost` compared the hostname as
written. `https://settlement./` and `https://localhost./` (a trailing dot is
the same DNS name) contain a dot, so they passed the single-label check.
`https://[::ffff:127.0.0.1]/` is normalized by `URL` to `::ffff:7f00:1`,
which matched no rule. `100.64.0.0/10` (CGNAT, which includes some cloud
metadata endpoints such as 100.100.100.200) was not listed.

**What it breaks.** The SSRF fix in #39 could be bypassed. A merchant could
still make the platform POST to `settlement:8091` or to loopback.

**How it was fixed.** In `webhooks/create.ts`: strip trailing dots before
checking, map `::ffff:x:y` back to IPv4 and check that, and add
`100.64.0.0/10`. Test #52 covers each bypass, plus public hosts that must
still pass.

Small fix: three lines in the existing helper. Still not covered (as #39
says): DNS names that resolve to private IPs, which needs resolve-time
pinning.

## 53. TLS private keys and `ops/.env` were baked into the Node image

**What is wrong and why.** `ops/Dockerfile.node` does `COPY . .`, and
`.dockerignore` did not exclude `ops/postgres/certs/` (including `ca.key` and
`server.key` from #49) or `ops/.env` (DB passwords and secrets from #4/#50).
Compose mounts both at runtime, so the image never needed them.

**What it breaks.** Anyone who can pull the api/reporting/migrate/seed image
gets the CA key (enough to mint a trusted Postgres certificate) and every
service password.

**How it was fixed.** `.dockerignore` now excludes `**/.env`,
`**/.env.local` and `ops/postgres/certs`.

Small fix: three ignore lines. **On any host that already built images:**
rebuild them and delete the old ones. If an image was ever pushed to a
registry, regenerate the certs and rotate the passwords.

## 54. Merchant session token wasn't rotated at OTP verification (session fixation)

**What is wrong and why.** #47 fixed this for admins only. Merchant
`POST /v1/auth/otp/verify` promoted the pending session in place, so the
pre-OTP cookie became the logged-in session. It also never re-set the cookie,
so the browser kept the login cookie's `maxAge` of the pending window (MK's
comment: "related to the 10 min logouts?").

**What it breaks.** Anyone who obtains or plants a merchant's pre-OTP cookie
is logged in as that merchant the moment the real user enters the code.
Separately, merchant users are logged out when the pending-window cookie
expires, even though the server-side session lasts the full TTL.

**How it was fixed.** The same as the admin path: verify generates a new
token, stores its hash on the session row in the promotion transaction, and
sets the new cookie with `maxAge = sessionTtlHours`. Test #54 in
`routes/reviewFixes.new.test.ts`: the new cookie differs and has the full
TTL, the old cookie gets 401 on `/v1/auth/me`, and the new one gets 200.

Small fix: one UPDATE and one `setCookie`. **This required changing the
locked helper `signupLoginAndVerify` in `app.test.ts`**, approved by the
user as for #47. It now returns the cookie that verify sets. No test
assertions were changed.

---

### Verification for entries 51–54

- `npm run typecheck` (api): clean.
- #51: migration 0080 run on the local database inside a rolled-back
  transaction. `original_captured_fils` was 8000 before and 4000 after;
  `filspay_api` and `filspay_reporting` still have SELECT.
- #52: every bypass URL rejected and the public controls allowed, run
  directly against `validateWebhookUrl`.
- #53: a throwaway build of the repo context contains no `ops/.env` and no
  `ops/postgres/certs`.
- **Not yet run:** `npm test` and `go test ./...`. The user is running them.
  Migration 0080 must be applied to the test database first.

---

# Refunds (FP-212) and the settlement summary

The briefing's "missing feature" is refunds. `POST /v1/refunds` returned 501,
and HANDOVER called the helper "done: it needs the route and the drawer
wired". Wiring it as-is would have shipped the six bugs below (#56–#61).
YA's note in `routes/refunds.ts` ("the helpers were written before the
capture discount and tier existed") was right.

## 55. Settlement summary counted multi-capture transactions several times (and was slow)

**What is wrong and why.** `getSettlementSummary` joined `transactions` to
its capture events but summed `t.captured_fils`, the transaction's running
total, once per event row. A sale captured in three parts of 3.000 BD added
3 + 6 + 9 = 18 BD instead of 9 BD. The same join fan-out is why Delta
Wholesale's summary took 3–6 s.

**What it breaks.** The summary is too high for every multi-capture merchant:
the 38% overstatement in `docs/perf/2026-07-settlement-summary-slow.md`. That
report put it down to "a timing difference that resolves at month end",
which came from an AI answer that nobody checked. It never resolves, because
batches sum `te.amount_fils` (each capture's own delta).

**How it was fixed.** Sum `te.amount_fils`, the same source `CloseBatch` and
the reconciliation report use. Test #55 in `routes/refunds.new.test.ts`
captures 3 × 3,000 and expects 9,000. The locked single-capture test still
holds.

Small fix: one column in one query.

## 56. The refund route (FP-212), and the drafted handler's two bugs

**What is wrong and why.** The route answered 501. Two half-built paths
existed: `/v1/refunds` (the registered stub) and
`/v1/merchants/:merchantId/refunds` (what `initiateMerchantRefund` and the
dashboard drawer expect). The AI-drafted handler in the stub's comment had
two bugs:
- `merchantId: auth, ...(request.body as any)` spreads the body *after* the
  authenticated merchant, so a body `merchantId` overrides it.
- It mints a new `idempotencyKey` per request, so a retried request refunds
  twice.

**How it was fixed.** One handler serves both paths:
- `/v1/merchants/:id/refunds` checks the path against the credential
  (`assertRefundRequestScope`, so a mismatch gets 403).
- The body is read field by field and validated.
- `Idempotency-Key` is required from the client, as on capture.
- Owner/finance roles only, and impersonation stays read-only (#23).

Test #56 covers, through the real routes:
- a partial refund, an idempotent replay (same body, one refund row), then a
  refund of the remainder;
- a further refund on a fully refunded transaction gets 409;
- the ledger nets to zero on `merchant_payable` and `platform_fee_revenue`;
- the timeline shows `refund_partial` and `refunded` with negative deltas,
  and its amounts sum to zero;
- two `refund.succeeded` outbox events, each with a valid envelope;
- reconciliation `gapFils = 0`;
- cross-merchant via the body gets 404, via the path gets 403, and a missing
  key gets 400.

**Dashboard drawer** (`RefundDrawer.tsx`, now wired into the transaction
page):
- It was hidden for `partially_refunded`, so a second partial refund was
  impossible.
- Its `max` was the captured amount, not what is still refundable.
- It made a new idempotency key per click, so a double-click could refund
  twice. The key now lives for one intended refund.

**Locked test now failing:** `routes/transactions.test.ts` "POST /v1/refunds
returns 501 not_implemented" asserts the stub. Its own comment says to
replace it when FP-212 lands.

## 57. Refunds handed discounted merchants back fee they never paid

**What is wrong and why.** `processRefund` read "fee charged" as every
`platform_fee_revenue` credit on the transaction. The negotiated discount
(#33) is a *debit* on that account (`capture: negotiated discount
adjustment`), so for a discounted merchant the refund reversed the full MDR,
including the part already rebated.

**What it breaks.** Every refund for a discounted merchant pays the merchant
the rebate a second time, and fee revenue for that sale goes negative.

**How it was fixed.** Fee charged is MDR credits minus discount-rebate
debits, matched by their capture descriptions so earlier refund reversals
aren't counted. Test #57: 20% discount, full refund, and fee revenue for the
sale nets to exactly 0 (before the fix it was minus the rebate).

Small fix: one query.

## 58. Settlement never netted refunds: refunded sales were paid out in full

**What is wrong and why.** `CloseBatch` selected only capture events. A
refund debited `merchant_payable` when it was journaled, but the batch net
(gross − fee) ignored it, so the payout included the refunded money anyway.
`refunds.settlement_batch_id` and its partial index (0042) were designed for
this and never used. MK's comment in `recalculate_mdr.go` ("refunds live in
their own table, non-issue") was only true because nothing netted them.

**What it breaks.** For every refund, the merchant gets the card money back
from the scheme *and* in their payout. The platform loses the refund amount.

**How it was fixed.**
- `CloseBatch` locks the merchant's unbatched succeeded refunds up to the
  window end and nets each one (`amount − fee reversed`) oldest first.
- It stores `refunded_fils` and `fee_reversed_fils` on the batch (migration
  0081) and marks each refund with the batch.
- A refund that would take the net below zero is left for a later batch.
  There is no lower date bound, so it is never lost. A payout can't be
  negative.
- `RecalculateMDR` now adjusts the frozen net by the fee difference. Before,
  it recomputed `gross − fee`, which would have silently dropped the netted
  refunds.

New Go tests (`refund_netting_new_test.go`): a 10,000 capture plus a 4,000
refund gives net `10000 − fee − 4000 + 100`; a refund larger than the day's
net stays unbatched.

Not changed: refunds don't add lines to the scheme export file. Whether a
refund is a negative scheme line is a question for the acquirer.

## 59. Merchants never got `refund.succeeded`, and reporting ignored it

**What is wrong and why.**
- `packages/events` listed `refund.succeeded`. The comment there says "so the
  dispatcher handles it? (yes per claude)". It didn't: the dispatcher's
  allow-list and `buildEnvelope` had only three event types.
- The reporting consumer's type filter also skipped it, so refunds never
  reached the rollups.
- The drafted `applyDailySummaryRollup` bucketed by UTC date, so a refund
  made between 00:00 and 03:00 Bahrain landed on the previous day.
- It wrote columns `merchant_daily_volume` didn't have, so it would have
  failed if called.

**How it was fixed.**
- An envelope case (`refundId`, `transactionId`, `merchantId`, `amountFils`,
  `feeReversedFils`, `refundedTotalFils`, `status`) is added first, then the
  type is added to the dispatcher list. The order matters: YA's comment
  explains that a type without an envelope stalls the whole queue.
- The reporting consumer applies `refund.succeeded`, bucketed with
  `toBahrainDateString`.
- Migration 0081 adds `refund_count` and `refund_gross_fils`.

Not changed: `GET /v1/analytics/volumes` doesn't expose the refund columns
yet. Its locked test deep-equals the point shape.

## 60. Reconciliation didn't count refunds (its docstring said it did)

**What is wrong and why.** The docstring said "refund legs are included both
in the ledger figure and in pending". Only the ledger had them. Pending
counted unbatched capture events only.

**What it breaks.** Any period with a refund shows an unexplained gap of
`amount − fee reversed`.

**How it was fixed.** Pending subtracts unbatched succeeded refunds'
`amount − fee_reversed`. Test #56 asserts `gapFils = 0` after a partial and
a full refund.

Small fix: one query. A refund deferred by #58 into a later day's batch shows
up as a gap on single-day reports for its own day. It explains to zero over
any range that includes both days.

## 61. The transaction page crashed on any refund

**What is wrong and why.** The dashboard's `bhd()` called `toFils(amount)`
without `allowNegative`. Refund events carry negative deltas (0044), so
rendering the timeline threw. MK's comment "amounts are never negative in
the dashboard" stopped being true when refunds were added.

**How it was fixed.** `toFils(amount, { allowNegative: true })`.
`formatBhd` already prints the sign.

Small fix: one option.

---

### Verification for entries 55–61

- `npm run typecheck` (all workspaces, db, scripts): clean. `go vet ./...`:
  clean.
- `apps/web` tests 8/8, and `vite build` succeeds.
- Migrations 0080 and 0081, plus the settlement refund query (which uses
  `idx_refunds_merchant_unbatched`), were run on the local database inside a
  rolled-back transaction. The service roles keep their grants.
- **Not yet run:** the DB-backed suites (`npm test`, and `go test ./...` with
  `DATABASE_URL`), which include `routes/refunds.new.test.ts` and
  `refund_netting_new_test.go`. Apply migrations 0080 and 0081 first.

---

# Hosting and capacity

## 62. Every `docker compose up` wiped the database, and seeded public passwords

**What is wrong and why.**
- `seed` is in the dependency chain of every service, so it runs on every
  `up`. `generate()` begins with `TRUNCATE ledger_entries, transactions,
  merchants, outbox_events, … CASCADE`.
- The seeded merchant and admin accounts all get passwords that are
  committed in `db/seed/generate.ts`.

**What it breaks.**
- On a hosted box, any restart, redeploy or reboot followed by `up` deletes
  every merchant, transaction and ledger row. `TRUNCATE` also bypasses the
  ledger's append-only trigger (#41).
- A freshly hosted stack has admin accounts that anyone with the repo can
  log into.

**How it was fixed.**
- The seed CLI skips a database that already has merchants;
  `SEED_RESET=true` forces it.
- Both seed passwords can be set from the environment
  (`SEED_USER_PASSWORD`, `SEED_ADMIN_PASSWORD`), and `docs/HOSTING.md`
  requires them on a host.

Verified: after rebuilding the local stack, the seed logged "database already
has data; skipping".

Small fix: one guard query, two `||` defaults. `generate()` itself is
unchanged.

## 63. The stack was dev-only: no restarts, no limits, public Postgres, no TLS

**What is wrong and why.** Compose had:
- no `restart` policy;
- no CPU or memory limits (the api must run at 0.5 vCPU / 512 MB);
- Postgres published on `0.0.0.0:5432`;
- the api on plain http `:3000`, and no TLS anywhere a browser connects;
- `NODE_ENV` unset, which leaves cookies non-secure, http webhooks allowed,
  and the SSRF guard off;
- no way to serve the frontends.

**How it was fixed.** In `ops/docker-compose.yml`:
- `restart: unless-stopped` and CPU/memory caps on every long-running
  service. The api gets exactly 0.5 vCPU / 512 MB with no swap, a V8 heap
  cap of 320 MB so it GCs before the cgroup kills it, and a `/healthz`
  healthcheck.
- Postgres is no longer published; the api binds to loopback only.
- A new `proxy` (nginx) terminates TLS, redirects http, and serves the built
  dashboard/checkout (`:443`) and admin console (`:8443`) same-origin with
  `/v1`.
- The api runs `NODE_ENV=production`, and `ACQUIRER_CALLBACK_SIGNING_SECRET`
  is now required.
- Bounded log rotation.

`docs/HOSTING.md` has the deploy steps and the recovery behaviour.

Verified on the local stack: all services healthy; `https://localhost/`
and `:8443` serve the apps; http gets 301; port 5432 refuses connections.

## 64. Overload queued until timeout or OOM

**What is wrong and why.** The api had no admission control and no
timeouts (`Fastify({ logger: true })`), and the pool waited 5 s for a
connection. Past capacity, requests queue in memory: everyone's latency
grows, then the 512 MB container is OOM-killed and every in-flight request
fails.

**How it was fixed.**
- `plugins/loadShedding.ts`: past `API_MAX_IN_FLIGHT` concurrent requests,
  new ones get **503 + `Retry-After: 1`** before any work is done. Health
  checks are exempt, and slots are released on `close`, so aborted requests
  can't leak them.
- Fastify `requestTimeout` / `connectionTimeout` of 15 s and a
  `keepAliveTimeout` above nginx's upstream keepalive.
- A 2 s pool connection timeout.
- nginx per-IP limits: 429 over 100 r/s on `/v1`, 10 r/s on auth, 50
  connections per IP.

Calibrated by the load test in `docs/CAPACITY.md`.

## 65. Nobody could log in to a production stack (OTP never delivered)

**What is wrong and why.** Both OTP notifiers deliver the code only by
logging it, and only when `NODE_ENV !== 'production'`. There is no email or
SMS channel ("console only until the SMS gateway contract lands" — Dec
2025). In production the code goes nowhere.

**What it breaks.** With the stack correctly in production mode (#63), no
merchant or admin can complete login.

**How it was fixed.** An explicit `OTP_LOG_CODES` switch (default: off in
production) replaces the `nodeEnv` check in both notifiers.
`docs/HOSTING.md` says it may be turned on for a demo, and that a real
delivery channel must replace it before real merchants use the platform.

Small fix: one config flag, one condition per notifier.

## 66. Checkout capacity capped at ~6/s by a 5-connection pool, and overload answered 500

**What is wrong and why.**
- `capture.ts` and `pay.ts` hold their database connection across the
  acquirer call, by design (the row lock serializes concurrent captures and
  refunds). The acquirer takes 100–400 ms per call, and a checkout makes two
  (authorize, capture). With the default `PG_POOL_MAX=5`, at most about 5
  checkouts can be in their acquirer phase at once.
- When the pool was full, the next request waited 2 s and then threw
  `timeout exceeded when trying to connect`. The error handler reported that
  as **500 internal_error**.

**What it breaks.** The first load test (`docs/CAPACITY.md`) plateaued at
about 6.3 checkouts/s from just 5 concurrent buyers, with the API at about
15% CPU: the pool was the limit, not the CPU. Beyond about 40 buyers,
checkouts got 500s instead of a clean "try again". One of them failed at
`pay.ts:125`, after authorization, which leaves the half-finished state
recorded as an open finding on #12.

**How it was fixed.**
- `PG_POOL_MAX=20` in compose. Postgres `max_connections` went 40 → 50:
  api 20 + settlement 4 + reporting + migrate, with headroom.
- The error handler maps a pool-acquire timeout to **503 + `Retry-After:
  1`**, like load shedding, and logs it as a warning.

Small fix: one environment value, one branch in the error handler. Not
changed: holding the connection across the acquirer call. Releasing it
would reopen the races #12 and #13 closed.

## 67. Every capture scanned the whole ledger several times (no index on `entry_group_id` / `transaction_id`)

**What is wrong and why.** The double-entry balance trigger (0007) is a
deferred `FOR EACH ROW` constraint trigger. At commit it runs `SELECT
SUM(...) FROM ledger_entries WHERE entry_group_id = $1` once for every
inserted row, and `entry_group_id` had no index. So did `transaction_id`,
which the per-capture discount guard, refunds and the rebuild all filter on.
A capture inserts at least four ledger rows, so each capture commit
sequentially scanned the entire ledger four or more times.

**What it breaks.** Checkout throughput, and it gets worse forever. On a
25,000-row ledger one load test performed **56,954 sequential scans and read
546,895,292 rows** of `ledger_entries`, against 8 index scans.
- Commits queued behind each other (`pg_stat_activity` showed sessions
  waiting at `COMMIT`), and throughput plateaued at about 7 checkouts/s with
  the API at 17% CPU.
- The cost is linear in ledger size: on a production ledger of millions of
  rows, every capture would take seconds.
- This is the likely cause of "one of the reporting queries is suspiciously
  slow" too: anything filtering the ledger by group or transaction scanned
  it.

**How it was fixed.** Migration 0082 adds `idx_ledger_entries_entry_group`
and `idx_ledger_entries_transaction`. The trigger's lookup went from a
sequential scan to an index scan (0.17 ms). For a large production ledger,
create them `CONCURRENTLY` by hand first; the migration's `IF NOT EXISTS`
then skips them.

Small fix: two indexes, and the trigger is unchanged. Found by the load test,
not by reading code: CPU was low, so we sampled `pg_stat_activity`, then
read `pg_stat_user_tables`.

## 68. Every capture scanned the whole `holds` table (no index on `holds.transaction_id`)

**What is wrong and why.** Capture and void release the authorization hold
with `UPDATE holds SET status = 'released' WHERE transaction_id = $1 AND
status = 'active'`. `holds.transaction_id` (0005) has no index, so each
release sequentially scans every hold ever written. Holds are never
deleted: the cleanup only touches expired ones (#9).

**What it breaks.** Checkout throughput falls as the platform ages. With the
ledger indexes from #67 in place, a 3-minute run at 60 buyers slowed from 10
to 7 checkouts/s as it went. `pg_stat_user_tables` showed `holds` with
11,195 sequential scans, 120,777,810 rows read, and **0 index scans**.

**How it was fixed.** Migration 0083 adds `idx_holds_transaction`.

Small fix: one index. The same `CONCURRENTLY` note as #67 applies on a large
production table.

---

# UI/UX

## 68. "View as merchant" opened the dashboard on its login page

**What is wrong and why.** The admin grant is its own cookie
(`fp_impersonation`), accepted by `requireMerchantAuth` on the data routes.
But the dashboard decides whether anyone is logged in from `GET
/v1/auth/me`, which used `requireSession` (merchant login sessions only), so
it returned 401. `DashboardAuthContext.tsx` says "impersonation does not
exist in the merchant plane": the two halves were never connected.

**What it breaks.** Support can't use the feature at all: the dashboard
shows the merchant login page. The workaround people would reach for,
asking for the merchant's password, is worse.

**How it was fixed.**
- `/v1/auth/me` tries the merchant session first, as before. Without one,
  it accepts a valid grant and answers with the merchant, role `support`
  and `impersonation: { adminUserId }`.
- Every write control in the dashboard is already wrapped in
  `RequireRole(owner, finance)`, so they disappear with no further change.
  The API still rejects writes (#23).
- The dashboard shows a persistent "Viewing as … (read-only)" banner and
  hides "Log out" while impersonating.

Test #68 (`routes/impersonationMe.new.test.ts`):
- a grant gets `/me` 200 with role `support`;
- a write is 403;
- no cookie, or an ended grant, is 401.

Verified on the local stack with a temporary grant (then ended).

Small fix: one fallback branch in `/me`, a banner, two optional type fields.

## 69. The admin "open the merchant dashboard" link landed on a 404 error screen

**What is wrong and why.** The admin console opened `WEB_BASE_URL`, the site
root. The dashboard router had no `/` route, so React Router showed its raw
"Unexpected Application Error! 404 Not Found". The same happened for any
mistyped path.

**How it was fixed.**
- The admin link and banner point at `${WEB_BASE_URL}/dashboard`.
- The dashboard redirects `/` and unknown paths to `/dashboard`, which goes
  to the login page when nobody is signed in.

Verified in a browser: `https://localhost/` and `/nope` now end on
`/dashboard/login` instead of the error screen.

Small fix: two routes and one URL.

## 70. "Recalculate MDR" set a batch's fee to 0 and credited the merchant the whole fee

**Found during manual admin testing on 2026-10-30.**

**What is wrong and why.** `recomputeBatchFee` re-derives a batch's fee
only from the capture events linked to it (`transaction_events.
settlement_batch_id`). A batch whose events aren't linked has no events to
sum, so the "new" fee comes out as 0. Seed data and any batch from before
migration 0023 are like this. The recalculation then posted the whole old
fee back to the merchant and rewrote the batch.

**What it breaks.** On the local stack, Alpha Retail's closed 2026-08-31
batch (gross 7,326.913 BHD, 29 scheme lines, 0 linked events) went from fee
183.174 BHD to 0, its net rose to the full gross, and an **"MDR
recalculation adjustment" of 183.174 BHD was credited to the merchant**.
Any closed legacy batch in a recalculated range gives its whole fee away.

**How it was fixed.**
- `recomputeBatchFee` also returns the gross of the events it summed.
- `RecalculateMDR` **skips** any batch where that doesn't equal the batch's
  `gross_fils`, and reports it in `skippedBatchIds`.
- The admin console shows "N batch(es) skipped and left unchanged" with the
  ids.

New Go test (`recalc_unlinked_new_test.go`): a closed batch with no linked
events is skipped, its fee and net are unchanged, and no adjustment rows are
written. The locked recalculation tests build their batches with
`CloseBatch`, so their events match and they still run.

Small fix: one comparison and one extra return value. **Local data:** the
183.174 BHD adjustment already posted stays in the ledger, which is
append-only (#41). It needs a forward correction if anyone cares about that
local balance.

## 71. Admin merchant page: clicking an action looked like it did nothing

**What is wrong and why.** Every action on the admin merchant page writes
its result into one message area at the top of the page:
- Recompute statuses
- Rotate key
- Issue credit
- Adjust balance
- KYC review

Most of those buttons sit far below it. After a click, the result rendered
off-screen and the admin saw no change.

**What it breaks.** During manual testing, "Recompute statuses" looked
broken. The request had succeeded (POST 200, "Scanned 21 transactions; 0
statuses updated"), but nothing visible changed. Admins re-click, which
re-runs money-adjacent actions, or report false bugs.

**How it was fixed.** The message area scrolls into view whenever a result
or error appears. It is also marked `role="status"` / `aria-live="polite"`,
so screen readers announce it.

Evidence, checked by Playwright on the same click at a 1280×800 viewport:
- before: message rendered, inside the visible screen **false**;
- after: inside the visible screen **true**.

Screenshots: `docs/ui-evidence/before-admin-action-result-off-screen.png`,
`docs/ui-evidence/after-admin-action-result-in-view.png`.

Small fix: one ref, one effect, one wrapper `div`. The actions themselves
are unchanged.

## 72. The "view as merchant" link pointed at a hostname baked in at build time

**What is wrong and why.** The admin console's link to the merchant
dashboard came from `VITE_WEB_BASE_URL`, which the proxy build filled in from
`PUBLIC_HOST` in `ops/.env`. With a placeholder in `.env` (`PUBLIC_HOST=HOST`)
the link was `https://host/dashboard`, which doesn't resolve. Fixing it
needed an `.env` change *and* a rebuild.

**How it was fixed.** When `VITE_WEB_BASE_URL` isn't set, the console
derives the dashboard's address from its own host at runtime (`https://<same
host>`; the dashboard is on 443, the console on 8443 of the same server). The
Vite dev servers keep their `localhost:5173` default. The proxy build no
longer takes the hostname as a build argument.

Verified in a browser: the banner link is `https://localhost/dashboard`, and
"View as merchant" opens Alpha Retail's transactions with the read-only
banner (`docs/ui-evidence/after-impersonation-dashboard.png`).

Small fix: one fallback expression, one build argument removed.
`CHECKOUT_BASE_URL` (payment-link URLs) still comes from `PUBLIC_HOST`: the
API has to know its public address. Set `PUBLIC_HOST` to the real host.
