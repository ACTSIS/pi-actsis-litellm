import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUsageRangeArg } from "../extensions/lib/commands.ts";

const NOW = Date.UTC(2025, 2, 27, 15, 30, 0); // 2025-03-27T15:30Z

describe("parseUsageRangeArg", () => {
  it("defaults to the last 30 days on empty args", () => {
    const parsed = parseUsageRangeArg("", NOW);
    assert.deepEqual(parsed, {
      range: { startDate: "2025-02-26", endDate: "2025-03-27" },
      label: "last 30 days",
    });
  });

  it("accepts a day count and clamps to at least 1 day", () => {
    const parsed = parseUsageRangeArg("7", NOW);
    if ("error" in parsed) throw new Error(parsed.error);
    assert.deepEqual(parsed, {
      range: { startDate: "2025-03-21", endDate: "2025-03-27" },
      label: "last 7 days",
    });
    const one = parseUsageRangeArg("1", NOW);
    if ("error" in one) throw new Error(one.error);
    assert.deepEqual(one.range, {
      startDate: "2025-03-27",
      endDate: "2025-03-27",
    });
    const zero = parseUsageRangeArg("0", NOW);
    if ("error" in zero) throw new Error(zero.error);
    assert.deepEqual(zero.range, {
      startDate: "2025-03-27",
      endDate: "2025-03-27",
    });
  });

  it("accepts ranges with 'to', '..', ',' and '→' separators", () => {
    for (const sep of ["to", "..", ",", "→"]) {
      const parsed = parseUsageRangeArg(`2025-03-01 ${sep} 2025-03-31`, NOW);
      assert.ok(!("error" in parsed), `separator ${sep} rejected`);
      assert.deepEqual(parsed.range, {
        startDate: "2025-03-01",
        endDate: "2025-03-31",
      });
      assert.equal(parsed.label, "2025-03-01 → 2025-03-31");
    }
  });

  it("rejects an inverted range", () => {
    const parsed = parseUsageRangeArg("2025-03-31 to 2025-03-01", NOW);
    assert.ok("error" in parsed);
    assert.match(parsed.error, /after end date/);
  });

  it("rejects unparsable input with a helpful message", () => {
    const parsed = parseUsageRangeArg("last week", NOW);
    assert.ok("error" in parsed);
    assert.match(parsed.error, /expected nothing|day count|range/);
  });
});