import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";

// docs/BUGFIXES.md #10: BD amounts were parsed as 2-decimal "cents" (4.75 -> 475).
test("BD amounts from finance's sheet become the right number of fils", () => {
  assert.equal(parseAdjustmentAmountFils("4.75"), 4_750);
  assert.equal(parseAdjustmentAmountFils("4.750"), 4_750);
  assert.equal(parseAdjustmentAmountFils("4.755"), 4_755);
  assert.equal(parseAdjustmentAmountFils("120.00"), 120_000);
  assert.equal(parseAdjustmentAmountFils("4141.90"), 4_141_900);
  assert.equal(parseAdjustmentAmountFils("-1.25"), -1_250);
});

test("more than three decimals is rejected, not silently truncated", () => {
  assert.throws(() => parseAdjustmentAmountFils("4.7555"), /could not parse amount/);
});
