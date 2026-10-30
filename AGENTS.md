# AI agent conventions — FilsPay

For every coding agent (Claude, Cursor, Copilot, Codex, ...). The full,
verified rule set is **`CLAUDE.md`** — read it before changing anything.
This file and `.cursorrules` deliberately only point there, so the three
can't drift apart again (the previous versions disagreed with the code and
with each other; CLAUDE.md lists the false rules they contained).

## The short version

1. Smallest fix that works; one `docs/BUGFIXES.md` entry per fix.
2. Verify before you assert — comments, docs and earlier AI answers in this
   repo have been wrong. Say when you couldn't check something.
3. Money is integer **fils** (1 BD = 1000). `parseBhdToFils` for text; no
   floats on any money path, TS or Go.
4. The settlement day is **Asia/Bahrain** midnight to midnight.
5. Don't modify `packages/money` / `apps/settlement/internal/money` or
   existing test files without sign-off; add `*.new.test.ts` /
   `*_new_test.go` instead. Some locked tests assert old bugs — leave them
   failing and say so.
6. Tokens and codes come from `crypto`; scope every query by the
   authenticated merchant; never spread a request body into an input.
7. Run `npm run typecheck`, `npm test` and `go test ./...` (sequentially,
   against a migrated database) before calling a change done.
