import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExpiredHoldsDelete } from "./expire_holds.js";
import { buildDelete } from "./lib/sqlFilter.js";

// docs/BUGFIXES.md #9: an empty id list used to produce `DELETE FROM holds`.
test("an empty id list never produces an unconditional DELETE", () => {
  assert.throws(() => buildExpiredHoldsDelete([]), /without a WHERE clause/);
});

test("buildDelete refuses when every filter is empty or missing", () => {
  assert.throws(() => buildDelete("holds", {}), /without a WHERE clause/);
  assert.throws(() => buildDelete("holds", { id: undefined, status: null }), /without a WHERE clause/);
});
