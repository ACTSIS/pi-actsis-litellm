import assert from "node:assert/strict";
import { it } from "node:test";
import { formatBudgetLine } from "../extensions/lib/budget.ts";
import { formatThrottleWarning } from "../extensions/lib/limit-errors.ts";
import { formatUsageSubsLines, type UsageSubscriptions } from "../extensions/lib/usage-subs.ts";
import {
  formatUsageLines, formatUsageTable, resolveUsageRangeDays,
  buildTopModelsBlock, buildTopModelsStatusEntries,
} from "../extensions/lib/usage.ts";

function subscriptions(generatedAt: string | null): UsageSubscriptions {
  return { generatedAt, subscriptions: [] };
}

it("shows absolute timestamps in the system zone, including date rollovers and DST", (t) => {
  const originalTZ = process.env.TZ;
  t.after(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });
  const cases = [
    ["America/Bogota", "2026-10-14T03:30:00Z", "2026-10-13 22:30 (America/Bogota, GMT-05:00)"],
    ["Asia/Tokyo", "2026-10-14T22:30:00Z", "2026-10-15 07:30 (Asia/Tokyo, GMT+09:00)"],
    ["America/New_York", "2026-03-08T06:30:00Z", "2026-03-08 01:30 (America/New_York, GMT-05:00)"],
    ["America/New_York", "2026-03-08T07:30:00Z", "2026-03-08 03:30 (America/New_York, GMT-04:00)"],
    ["UTC", "2026-10-14T03:30:00Z", "2026-10-14 03:30 (UTC, GMT+00:00)"],
  ];
  for (const [zone, instant, expected] of cases) {
    process.env.TZ = zone;
    const reset = Date.parse(instant);
    t.mock.method(Date, "now", () => reset - 35 * 60_000);
    assert.equal(formatUsageSubsLines(subscriptions(instant))[0],
      `Usage subscriptions (generated at ${expected}):`);
    assert.equal(formatBudgetLine({
      spend: 50, maxBudget: 100, budgetResetAt: reset,
      tpmLimit: null, rpmLimit: null, keyAlias: null,
    }), `$50.00 / $100.00 used (50%) | resets ${expected}`);
    assert.equal(formatThrottleWarning({
      kind: "throttling_error", limitType: "tokens", resetsAt: reset, raw: "",
    }), `Rate limit reached (tokens). Resets at ${expected} (~35 min). pi will retry automatically.`);
    t.mock.restoreAll();
  }
});

it("keeps unavailable timestamps unavailable instead of displaying Invalid Date", () => {
  for (const value of [null, "not-a-date"]) {
    assert.deepEqual(formatUsageSubsLines(subscriptions(value)), [
      "Usage subscriptions (generated at -):", "(no subscriptions returned)",
    ]);
  }
});

it("labels UTC query days without changing query dates or totals", (t) => {
  const originalTZ = process.env.TZ;
  t.after(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });
  for (const zone of ["America/Bogota", "Asia/Tokyo"]) {
    process.env.TZ = zone;
    const range = resolveUsageRangeDays(7, Date.parse("2026-10-14T01:00:00Z"));
    assert.deepEqual(range, { startDate: "2026-10-08", endDate: "2026-10-14" });
    const summary = {
      ...range, totals: { spend: 2, totalTokens: 30, apiRequests: 4, promptTokens: 10, completionTokens: 20 }, models: [],
    };
    assert.equal(formatUsageTable(summary)[0], "Usage 2026-10-08 → 2026-10-14 (7 UTC days): $2.0000");
    assert.equal(formatUsageLines(summary)[0], "Usage 2026-10-08 → 2026-10-14 (7 UTC days): spend $2.0000, 30 tokens, 4 requests");
    assert.ok(buildTopModelsBlock({ windowLabel: "7d", rows: [] }).some(line => line.includes("Top models (7d, UTC days)")));
    assert.equal(buildTopModelsStatusEntries({ windowLabel: "7d", rows: [] })[0].text, "Top models (7d, UTC days)");
  }
});
