# AI usage and setup

How the team used AI on this audit, and how we checked what it told us.
The judges asked for setup files plus three annotated transcript excerpts.

## Setup files in the repo

| File | Purpose |
|---|---|
| `CLAUDE.md` | The verified rule set for AI agents. Each rule cites the BUGFIXES entry that justifies it. It ends with a table of the **false claims** that the original version of this file contained. |
| `AGENTS.md` | A short version for any agent, pointing to `CLAUDE.md`. |
| `.cursorrules` | Points to `CLAUDE.md`. |

The original three files disagreed with the code, and with each other, in at
least 13 places, and an agent that followed them would have reintroduced
bugs. Examples: amounts in "cents", settlement on "UTC midnight",
"`Math.random` is fine for OTP codes", "don't fix the refunds 501". We
treated them as claims to verify, not instructions, and rewrote them only
after each rule had been checked against the code.

Working rules we held the AI to:
- Every fix gets a `docs/BUGFIXES.md` entry, and the smallest fix wins.
- A new regression test must fail without the fix.
- The AI says what it did **not** verify.

The developer, not the AI, ran the database-backed test suites. The AI's
sandbox blocked it from reading `ops/.env` (secrets), and we kept that
block in place.

---

## Excerpt 1: an AI-written review, checked against the code

**Context.** An earlier AI pass produced `docs/BUGFIX_REVIEW.md`, a
row-by-row status of all 50 fixes. Before acting on it, we asked Claude to
check it.

> **Claude:** The review was written from reading the code only, without
> running anything. I'll check a few of its claims against the code before
> giving an assessment.
>
> *(greps `.dockerignore`, the compose file, `routes/auth.ts`,
> `payout_estimate.go`, `platform_volume.go`)*
>
> **Rows that don't match the bug they're numbered for** — #7: BUGFIXES.md
> says the session lookup was missing `authenticated = true`; the review
> assessed "Bypass gated to test configuration", which is really #45 … #19:
> says the "UTC-based window was corrected", which is backwards. It also
> suggests DST tests, but Bahrain has no DST.
>
> **New gaps it raises that I confirmed in the code** — Secrets in images:
> `ops/Dockerfile.node` does `COPY . .`, and `.dockerignore` doesn't exclude
> `ops/postgres/certs/` or `ops/.env` … I didn't check the review's other
> claims: #11 concurrent overwrite, #12 crash after claim, #39 SSRF
> bypasses, and #43 refresh and over-counting.

Then, while fixing:

> **Claude:** Both turn out not to be bugs: `platform_stats`: migration 0049
> seeds row `id = 1` … `EstimateMonthlyPayout`: nothing calls it.
>
> **Review claims I didn't fix, because they aren't bugs:** Unique
> `delivery_event_id`: retries and replays deliberately reuse the same id
> (#40), so this constraint would break replays.

**Annotation.**
- **Claim:** an AI review said 50 fixes were Fixed or Partially Fixed, and
  listed new gaps.
- **Check:** each claim was traced to a file and line. A claim was only
  accepted once the code showed it: a `COPY . .` line, a test build showing
  the keys inside the image.
- **Result:**
  - **Confirmed, became real fixes:** the image secrets (#53), the SSRF
    bypasses (#52, verified by feeding the guard the bypass URLs), merchant
    session fixation (#54), and the refund summary over-count (#51, verified
    with a rolled-back SQL run: 8,000 fils before, 4,000 after).
  - **Rejected:** three suggestions. One of them, a unique
    `delivery_event_id` constraint, would have broken webhook replays.
  - **Disclosed:** what wasn't checked was said up front, not glossed over.

## Excerpt 2: "the dispatcher handles it? (yes per claude)"

**Context.** While building refunds, the outbox type list in
`packages/events/src/outbox.ts` carried this comment: `FH: refund.succeeded is
already here, so the dispatcher handles it? (yes per claude)`.

> **Claude:** Two comments here make claims I need to check:
> - `outbox.ts`: "the dispatcher handles it? (yes per claude)"
> - MK: refund events "won't carry settlement_batch_id"
>
> Reading the dispatcher and envelope:
>
> *(tool output: `WEBHOOK_ELIGIBLE_EVENT_TYPES = ["transaction.captured",
> "transaction.voided", "settlement.paid"]`; `buildEnvelope` has three cases
> and a `default: throw`)*
>
> **Claude:** Claude's "yes" in that comment was wrong. The dispatcher only
> sends three event types and the envelope has no `refund.succeeded` case,
> so merchants would never get the webhook.

**Annotation.**
- **Claim:** an earlier AI answer, preserved in a code comment, said the
  webhook already worked.
- **Check:** read the two places that decide delivery (the allow-list and
  the envelope builder) rather than trusting the type union.
- **Result:**
  - The claim was false.
  - We also followed YA's warning in `dispatcher.ts`: adding a type
    without an envelope case throws and stalls the whole queue. So the
    envelope case went in first, then the allow-list entry (#59).
  - The regression test builds a real envelope from the outbox row the
    refund produced.
  - The same check found the reporting consumer had the same gap.

## Excerpt 3: an AI explanation in a perf report

**Context.** `docs/perf/2026-07-settlement-summary-slow.md` records that the
settlement summary showed 38% more captured volume than the batches for one
merchant, and: *"I asked Claude about the difference and it explained that
the summary counts captures at capture time while batches count them at
close … a timing difference that resolves at month end."* The issue was
closed with no code change.

> **Claude:** This report contains an unfixed money bug. The summary is 38%
> too high for multi-capture merchants, and the explanation Claude gave
> Fatima ("a timing difference that resolves at month end") is very likely
> wrong. Checking the query:
>
> *(tool output: the CTE selects `t.captured_fils` per joined capture event,
> then `SUM(captured_fils)`)*
>
> **Claude:** That's a fan-out bug. Each capture event pulls in the
> transaction's whole `captured_fils`, so a transaction captured in three
> parts is counted three times.
>
> *(later)* Checking that the Go batch close sums the same column, so the
> summary and batches now match: … `te.amount_fils`.

**Annotation.**
- **Claim:** an AI explanation, accepted without checking, called a money
  discrepancy "timing".
- **Why it failed:** a timing difference would net out, but this one never
  does. The explanation fit the symptom, not the code.
- **Check:** read the query, then the Go batch query that defines the
  correct figure.
- **Result:**
  - A one-column fix (#55).
  - A regression test: 3 captures of 3,000 now give 9,000 (it was 18,000).
  - The locked single-capture test still passes.
- **Hedging:** the AI said "very likely wrong" before reading the query,
  and only stated it as fact after reading it.

---

## Where a human overrode or corrected the AI

- **Wrong file.** The developer asked to "look at" the review, and Claude
  summarised `BUGFIXES.md` instead. The developer corrected it ("i meant
  this BUGFIX_REVIEW.md").
- **Locked tests.** Claude stopped and asked before editing locked test
  helpers (#47, #54). The developer approved a helper-only change; no
  assertions changed.
- **Secrets.** The sandbox denied Claude reading `ops/.env`. Claude did not
  work around it and asked the developer to run the DB-backed suites.
- **Open finance decision.** The conflicting refund-status rules in
  `refundState.ts` were left for finance rather than decided by the AI.
