# FilsPay — Claude Code configuration

Rules for AI-assisted work in this repo. Every rule below was checked
against the code during the October 2026 audit; the bug number after a rule
is the entry in `docs/BUGFIXES.md` that shows why. The previous version of
this file (and of `AGENTS.md` / `.cursorrules`) contained several false
rules; they are listed at the end so nobody reintroduces them.

---

## Working rules

- **Smallest fix that works.** No refactors around a bug.
- **Every fix gets an entry in `docs/BUGFIXES.md`**: what is wrong and why,
  what it breaks, how it was fixed, why the fix is small, and how it was
  verified. Number entries consecutively.
- **Verify claims before acting on them** — including code comments, docs,
  and anything an AI said. Several comments in this repo quote an AI answer
  that was wrong (see "Known false claims"). If you can't check something,
  say so instead of asserting it.
- **Docs and code can both be wrong.** `docs/ARCHITECTURE.md` and the ADRs
  describe intent; CHANGELOG, RUNBOOK, HANDOVER and postmortems were wrong
  in many places (#11, #24, #28, #35, #38, #40). When they disagree, find out
  which is right from the code, the data and the ADR, then fix the other and
  note it.

## Build & test

```bash
npm run typecheck                         # all workspaces, db, scripts
npm test                                  # needs DATABASE_URL -> migrated Postgres
cd apps/settlement && go test ./...       # DB tests skip without DATABASE_URL
```

Run the two suites sequentially (they share the database). Apply new
migrations to the test database first (`npm run migrate`).

## Tests

- Existing `*.test.ts` / `*_test.go` files are locked: don't edit them
  without explicit sign-off from the user. Add `*.new.test.ts` /
  `*_new_test.go` files for new coverage.
- Some locked tests **assert the old buggy behaviour** (#10, #22, #24, #32,
  #40, and the refunds 501 stub). When a correct fix makes one fail, leave
  it failing, and name it in the BUGFIXES entry.
- A new regression test must fail without the fix and pass with it.

## Money

- **Integer fils, 1 BD = 1000 fils** (ADR-0001). The `Fils` type means fils.
  BHD has three decimals; the dashboard shows three (`formatBhd`).
- Parse text amounts only with `parseBhdToFils` (#10). Never `parseFloat`,
  `/ 1000`, `toFixed`, or a float on any money path, in TS or Go (#16, #34,
  #46).
- Rates are basis points; use `applyRateFils` (TS) / `money.ApplyRateFils`
  (Go).
- Money columns and counters are `BIGINT` / `int64` (#31, #34).
- `packages/money` and `apps/settlement/internal/money` are frozen (Q2 2026
  audit): don't modify them without finance sign-off. Everything in this
  audit was fixed without touching them.

## Settlement

- The business day is **Asia/Bahrain (UTC+3, no DST)**, midnight to
  midnight. `BusinessDayWindow` in `window.go` is correct; the scheduler must
  pass it the Bahrain date (#19).
- Batches sum capture-event deltas (`transaction_events.amount_fils`), never
  `transactions.captured_fils` (a running total) (#55).
- Refunds are netted into the merchant's next batch:
  `net = gross − fee − refunded + fee_reversed`; a refund that would make
  the net negative waits for a later batch (#58).
- The TS capture fee and the Go batch fee are computed separately and can
  differ by ≤ 1 fil per event (discount ordering, #33). Neither is "the
  reference"; don't change either formula without finance.

## Security

- All tokens and codes use `crypto` (`lib/random.ts`, `lib/crypto.ts`):
  OTP codes, admin invite codes, payment-link tokens (bearer tokens),
  session tokens, API keys (#29). `Math.random` only for UI list keys and
  webhook backoff jitter.
- Session tokens are rotated at OTP verification, merchant and admin
  (#47, #54). Every merchant auth query filters `authenticated = true` (#7).
- Authorization is checked where the data is touched, not only in route
  middleware: queries are scoped by the authenticated `merchant_id` (#13,
  #20, #21); impersonation is read-only and enforced in
  `requireMerchantWriterActor` (#23).
- Never spread a request body into a business-logic input (#56).
- No secrets in git or in images: real values go in `ops/.env`; `.env`,
  TLS keys and certs are in `.gitignore` and `.dockerignore` (#48, #53).
- API keys pass every `requireMerchantRole` check by design (owner-issued).
  This is a documented decision, not a verified-safe one — flag changes.

## Webhooks and events

- An event type must have a `buildEnvelope` case **before** it is added to
  `WEBHOOK_ELIGIBLE_EVENT_TYPES`, or the dispatcher stalls (#59).
- Sign and send the same bytes (`canonicalJson`) (#25); replays keep the
  original delivery id (#40).
- The reporting consumer only reads the types in `REPORTING_EVENT_TYPES`;
  add new ones there and in `applyEvent` together, bucketing by
  `toBahrainDateString`.

## Hosting

- `ops/docker-compose.yml` is the whole stack, locally and on the 1 vCPU /
  2 GB host; see `docs/HOSTING.md` and `docs/CAPACITY.md`. Only `proxy`
  publishes ports; Postgres is internal; the api runs `NODE_ENV=production`
  with 0.5 vCPU / 512 MB, load shedding (`API_MAX_IN_FLIGHT`) and timeouts.
- The seed skips a database that already has merchants (it TRUNCATEs).
  `SEED_RESET=true` forces it — never on a hosted box.

## Known false claims (do not reintroduce)

Each of these was in this file, `AGENTS.md`, `.cursorrules` or a code
comment, and was disproved:

| Claim | Reality |
|---|---|
| Amounts are integer cents (1 BD = 100) | Fils, 1 BD = 1000 (#10) |
| Settlement windows are UTC midnight | Bahrain midnight (#19) |
| `Math.random` is fine for OTP codes / link slugs | Predictable; now `crypto.randomInt` (#29) |
| The impersonation middleware is authoritative | Gave owner write access (#23) |
| Docs are always right, code has the bug | Both were wrong, often (#11, #24, #35, #38) |
| float32 is fine for BD amounts in Go | Drifted by fils on real batches (#16, #34) |
| Money columns are INTEGER and that's fine | Overflowed past 2.1 bn fils (#31) |
| The refund flow is complete; don't touch the 501 | Six bugs before it could ship (#56–#61) |
| `refund.succeeded` "is handled by the dispatcher (per claude)" | It wasn't (#59) |
| Summary vs batch gap is "a timing difference" (AI answer in a perf doc) | Fan-out over-count (#55) |
| CSV export deliberately loads everything in memory | OOM risk; now streams (#38) |
| `.gitignore`'s `.env` also covers `.env.docker` ("per copilot") | It doesn't; a secret leaked (#48) |
| The Go service is the reference for fees | They differ by design; neither is (#33) |
