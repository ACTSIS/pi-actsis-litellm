import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyModelAliases,
  fetchModelUsage,
  formatUsageLines,
  isoDay,
  mapModelAliases,
  resolveDefaultUsageRange,
} from "../extensions/lib/usage.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function dailyActivityBody() {
  return {
    results: [
      {
        date: "2025-03-26",
        metrics: {
          spend: 0.01,
          prompt_tokens: 100,
          completion_tokens: 200,
          total_tokens: 300,
          api_requests: 3,
        },
        breakdown: {
          models: {
            "gpt-x": {
              spend: 0.008,
              prompt_tokens: 60,
              completion_tokens: 150,
              total_tokens: 210,
              api_requests: 2,
            },
            "claude-y": {
              spend: 0.002,
              prompt_tokens: 40,
              completion_tokens: 50,
              total_tokens: 90,
              api_requests: 1,
            },
          },
        },
      },
      {
        date: "2025-03-27",
        metrics: {
          spend: 0.02,
          prompt_tokens: 150,
          completion_tokens: 250,
          total_tokens: 400,
          api_requests: 4,
        },
        breakdown: {
          models: {
            "gpt-x": {
              spend: 0.012,
              prompt_tokens: 70,
              completion_tokens: 180,
              total_tokens: 250,
              api_requests: 3,
            },
          },
        },
      },
    ],
    metadata: {
      total_spend: 0.03,
      total_prompt_tokens: 250,
      total_completion_tokens: 450,
      total_tokens: 700,
      total_api_requests: 7,
    },
  };
}

interface FetchRecorder {
  restore: () => void;
  captured: string[];
}

function mockFetch(
  impl: (requestUrl: URL, request: Request) => Response | Promise<Response>,
): FetchRecorder {
  const original = globalThis.fetch;
  const captured: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = new URL(String(input));
    captured.push(requestUrl.toString());
    const request = new Request(String(input), init);
    return Promise.resolve(impl(requestUrl, request));
  }) as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const RANGE = { startDate: "2025-03-20", endDate: "2025-03-27" };

describe("resolveDefaultUsageRange", () => {
  it("returns the last 30 days inclusive of today", () => {
    const now = Date.UTC(2025, 2, 27, 15, 30, 0);
    const range = resolveDefaultUsageRange(now);
    assert.equal(range.startDate, "2025-02-26");
    assert.equal(range.endDate, "2025-03-27");
  });

  it("isoDay formats a UTC timestamp as YYYY-MM-DD", () => {
    assert.equal(isoDay(Date.UTC(2025, 11, 5, 23, 59)), "2025-12-05");
  });
});

describe("fetchModelUsage", () => {
  it("requests /user/daily/activity with explicit date params and bearer auth", async () => {
    let seenAuth: string | null = null;
    const recorder = mockFetch((requestUrl, request) => {
      assert.equal(requestUrl.pathname, "/user/daily/activity/aggregated");
      assert.equal(requestUrl.searchParams.get("start_date"), "2025-03-20");
      assert.equal(requestUrl.searchParams.get("end_date"), "2025-03-27");
      seenAuth = request.headers.get("authorization");
      return jsonResponse(dailyActivityBody());
    });
    try {
      await fetchModelUsage(
        "http://gw.example:4000/",
        "sk-test",
        5_000,
        RANGE,
      );
      assert.equal(seenAuth, "Bearer sk-test");
      assert.equal(recorder.captured.length, 1);
      assert.ok(
        recorder.captured[0].startsWith(
          "http://gw.example:4000/user/daily/activity/aggregated",
        ),
      );
    } finally {
      recorder.restore();
    }
  });

  it("aggregates per-model metrics across days, sorted by spend desc", async () => {
    const recorder = mockFetch(() => jsonResponse(dailyActivityBody()));
    try {
      const summary = await fetchModelUsage(
        "http://gw.example:4000",
        "sk-test",
        5_000,
        RANGE,
      );
      assert.equal(summary.startDate, "2025-03-20");
      assert.equal(summary.endDate, "2025-03-27");
      assert.deepEqual(summary.totals, {
        spend: 0.03,
        promptTokens: 250,
        completionTokens: 450,
        totalTokens: 700,
        apiRequests: 7,
      });
      assert.deepEqual(
        summary.models.map((m) => [m.model, m.spend, m.apiRequests]),
        [
          ["gpt-x", 0.02, 5],
          ["claude-y", 0.002, 1],
        ],
      );
      assert.deepEqual(summary.models[0], {
        model: "gpt-x",
        spend: 0.02,
        promptTokens: 130,
        completionTokens: 330,
        totalTokens: 460,
        apiRequests: 5,
      });
    } finally {
      recorder.restore();
    }
  });

  it("derives totals from results when metadata is missing", async () => {
    const body = dailyActivityBody() as {
      results: unknown[];
      metadata?: unknown;
    };
    delete body.metadata;
    const recorder = mockFetch(() => jsonResponse(body));
    try {
      const summary = await fetchModelUsage(
        "http://gw.example:4000",
        "sk-test",
        5_000,
        RANGE,
      );
      assert.equal(summary.totals.spend, 0.03);
      assert.equal(summary.totals.apiRequests, 7);
    } finally {
      recorder.restore();
    }
  });

  it("uses metadata totals when results are empty", async () => {
    const recorder = mockFetch(() =>
      jsonResponse({
        results: [],
        metadata: {
          total_spend: 0.5,
          total_prompt_tokens: 100,
          total_completion_tokens: 200,
          total_tokens: 300,
          total_api_requests: 5,
        },
      }),
    );
    try {
      const summary = await fetchModelUsage("http://gw:4000", "sk-x", 5_000, RANGE);
      assert.deepEqual(summary.totals, {
        spend: 0.5,
        promptTokens: 100,
        completionTokens: 200,
        totalTokens: 300,
        apiRequests: 5,
      });
    } finally {
      recorder.restore();
    }
  });

  it("falls back to row sums per missing metadata key", async () => {
    const body = dailyActivityBody() as {
      results: unknown[];
      metadata: Record<string, number>;
    };
    // Metadata carries only spend; the rest must fall back to row sums.
    body.metadata = { total_spend: 0.031 };
    const recorder = mockFetch(() => jsonResponse(body));
    try {
      const summary = await fetchModelUsage(
        "http://gw.example:4000",
        "sk-test",
        5_000,
        RANGE,
      );
      assert.equal(summary.totals.spend, 0.031);
      assert.equal(summary.totals.apiRequests, 7);
      assert.equal(summary.totals.totalTokens, 700);
      assert.equal(summary.totals.promptTokens, 250);
      assert.equal(summary.totals.completionTokens, 450);
    } finally {
      recorder.restore();
    }
  });

  it("maps 401 to AuthError without retry", async () => {
    const recorder = mockFetch(() =>
      jsonResponse({ detail: "Invalid API key" }, 401),
    );
    try {
      await assert.rejects(
        fetchModelUsage("http://gw:4000", "sk-bad", 5_000, RANGE),
        /Credential rejected by gateway/,
      );
    } finally {
      recorder.restore();
    }
  });

  it("maps 403 to the permission-flavored AuthError", async () => {
    const recorder = mockFetch(() =>
      jsonResponse({ detail: "no spend routes" }, 403),
    );
    try {
      await assert.rejects(
        fetchModelUsage("http://gw:4000", "sk-x", 5_000, RANGE),
        /denied access to usage info \(403\)/,
      );
    } finally {
      recorder.restore();
    }
  });

  it("maps invalid JSON to CatalogError", async () => {
    const recorder = mockFetch(() => new Response("not json", { status: 200 }));
    try {
      await assert.rejects(
        fetchModelUsage("http://gw:4000", "sk-x", 5_000, RANGE),
        /not valid JSON/,
      );
    } finally {
      recorder.restore();
    }
  });

  it("maps empty results to zero totals and the no-usage message", async () => {
    const recorder = mockFetch(() => jsonResponse({ results: [], metadata: {} }));
    try {
      const summary = await fetchModelUsage(
        "http://gw:4000",
        "sk-x",
        5_000,
        RANGE,
      );
      assert.equal(summary.totals.spend, 0);
      assert.equal(summary.models.length, 0);
      const lines = formatUsageLines(summary);
      assert.match(lines[0], /spend \$0\.0000/);
      assert.match(lines[1], /no logged model usage/);
    } finally {
      recorder.restore();
    }
  });
});

describe("formatUsageLines", () => {
  it("formats totals and per-model rows", () => {
    const lines = formatUsageLines({
      startDate: "2025-03-20",
      endDate: "2025-03-27",
      totals: {
        spend: 0.03,
        promptTokens: 250,
        completionTokens: 450,
        totalTokens: 700,
        apiRequests: 7,
      },
      models: [
        {
          model: "gpt-x",
          spend: 0.02,
          promptTokens: 130,
          completionTokens: 330,
          totalTokens: 460,
          apiRequests: 5,
        },
      ],
    });
    assert.equal(lines.length, 2);
    assert.match(
      lines[0],
      /Usage 2025-03-20 → 2025-03-27 \(8 days\): spend \$0\.0300/,
    );
    assert.match(lines[1], /gpt-x\s+\$0\.0200\s+460 tok\s+5 reqs/);
  });
});
describe("mapModelAliases", () => {
  const publicIds = ["oc/glm-5.3-flash", "oc/glm-5.3", "oc/qwen3.6-35b"];

  it("passes through keys that already match a public id", () => {
    const aliases = mapModelAliases(["oc/glm-5.3-flash"], publicIds);
    assert.equal(aliases.get("oc/glm-5.3-flash"), undefined);
  });

  it("maps an internal deployment name to the public alias via shared suffix", () => {
    const aliases = mapModelAliases(
      ["openai/glm-5.3-flash", "openai/deepseek-v4.1-flash"],
      publicIds,
    );
    assert.equal(aliases.get("openai/glm-5.3-flash"), "oc/glm-5.3-flash");
    assert.equal(aliases.get("openai/deepseek-v4.1-flash"), undefined);
  });

  it("is deterministic when two public ids share a suffix (sorted first wins)", () => {
    const aliases = mapModelAliases(
      ["openai/glm-5.3-flash"],
      ["oc/glm-5.3-flash", "team2/glm-5.3-flash"],
    );
    assert.equal(aliases.get("openai/glm-5.3-flash"), "oc/glm-5.3-flash");
  });

  it("leaves unknown keys alone (e.g. non-chat models filtered from catalog)", () => {
    const aliases = mapModelAliases(["openai/nomic-embed"], publicIds);
    assert.equal(aliases.get("openai/nomic-embed"), undefined);
  });

  it("is case-insensitive on the suffix", () => {
    const aliases = mapModelAliases(["openai/GLM-5.3-Flash"], publicIds);
    assert.equal(aliases.get("openai/GLM-5.3-Flash"), "oc/glm-5.3-flash");
  });
});

describe("applyModelAliases", () => {
  const baseSummary = () => ({
    startDate: "2025-03-01",
    endDate: "2025-03-31",
    totals: {
      spend: 0.3,
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
      apiRequests: 6,
    },
    models: [
      { model: "openai/glm-5.3-flash", spend: 0.2, promptTokens: 10, completionTokens: 20, totalTokens: 30, apiRequests: 2 },
      { model: "oc/glm-5.3-flash", spend: 0.1, promptTokens: 20, completionTokens: 40, totalTokens: 60, apiRequests: 1 },
      { model: "oc/qwen3.6-35b", spend: 0.1, promptTokens: 70, completionTokens: 140, totalTokens: 210, apiRequests: 3 },
    ],
  });

  it("merges entries aliasing to the same public id and re-sorts by spend", () => {
    const aliases = new Map([["openai/glm-5.3-flash", "oc/glm-5.3-flash"]]);
    const merged = applyModelAliases(baseSummary(), aliases);
    assert.deepEqual(
      merged.models.map((m) => [m.model, Math.round((m.spend ?? 0) * 1e6) / 1e6, m.apiRequests]),
      [
        ["oc/glm-5.3-flash", 0.3, 3],
        ["oc/qwen3.6-35b", 0.1, 3],
      ],
    );
    // Totals are unchanged by display-time merging.
    assert.equal(merged.totals.spend, 0.3);
    assert.equal(merged.totals.apiRequests, 6);
  });

  it("returns an equivalent summary when the alias map is empty", () => {
    const merged = applyModelAliases(baseSummary(), new Map());
    assert.deepEqual(merged.models, baseSummary().models);
  });

  it("keeps totals independent from the input (no shared mutable state)", () => {
    const aliases = new Map([["openai/glm-5.3-flash", "oc/glm-5.3-flash"]]);
    const original = baseSummary();
    applyModelAliases(original, aliases);
    assert.equal(original.models.length, 3);
  });
});

import {
  buildTopModelsBlock,
  formatCompactTokens,
  formatUsageTable,
  resolveUsageRangeDays,
} from "../extensions/lib/usage.ts";

describe("resolveUsageRangeDays", () => {
  it("returns the last N days inclusive of today", () => {
    const range = resolveUsageRangeDays(7, Date.UTC(2025, 2, 27, 15, 30, 0));
    assert.deepEqual(range, { startDate: "2025-03-21", endDate: "2025-03-27" });
  });

  it("clamps to at least one day", () => {
    const range = resolveUsageRangeDays(0, Date.UTC(2025, 2, 27));
    assert.equal(range.startDate, "2025-03-27");
  });
});

describe("formatCompactTokens", () => {
  it("uses B/M/k scales", () => {
    assert.equal(formatCompactTokens(786_264_305), "786.3M");
    assert.equal(formatCompactTokens(1_289_046), "1.29M");
    assert.equal(formatCompactTokens(14_763), "14.8k");
    assert.equal(formatCompactTokens(837), "837");
  });

  it("renders null as dash", () => {
    assert.equal(formatCompactTokens(null), "-");
  });
});

describe("formatUsageTable", () => {
  const summary = () => ({
    startDate: "2025-03-01",
    endDate: "2025-03-31",
    totals: {
      spend: 0.3,
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
      apiRequests: 6,
    },
    models: [
      { model: "oc/glm-5.3-flash", spend: 0.2, promptTokens: 10, completionTokens: 20, totalTokens: 30, apiRequests: 2 },
      { model: "oc/qwen3.6-35b", spend: 0.1, promptTokens: 70, completionTokens: 140, totalTokens: 210, apiRequests: 3 },
    ],
  });

  it("renders an aligned table with header, rows and totals row", () => {
    const lines = formatUsageTable(summary());
    assert.match(lines[0], /^Usage 2025-03-01/);
    assert.match(lines[1], /^Model\b/);
    assert.ok(lines[1].includes("Spend"));
    assert.ok(lines.some((l) => l.includes("---")));
    assert.ok(lines.at(-1)!.includes("Total"));
    assert.ok(lines.at(-1)!.includes("$0.3000"));
    // Columns are aligned: right-aligned numeric columns end at the same index.
    const spendEnd = lines[1].indexOf("Spend") + "Spend".length;
    const rowEnd = lines[3].indexOf("$0.2000") + "$0.2000".length;
    assert.equal(spendEnd, rowEnd);
  });

  it("truncates to topN when requested", () => {
    const many = summary();
    many.models = [
      ...many.models,
      ...Array.from({ length: 5 }, (_, i) => ({ model: `m${i}`, spend: 0.001 * (5 - i), promptTokens: 1, completionTokens: 1, totalTokens: 2, apiRequests: 1 })),
    ];
    const lines = formatUsageTable(many, { topN: 5 });
    assert.match(lines.at(-1)!, /Total/);
    // Top 5 = 2 original rows + m0..m2 (m3/m4 are cut, counted in the note).
    assert.ok(lines.some((l) => l.includes("m0")));
    assert.ok(lines.some((l) => l.includes("m2")));
    assert.ok(!lines.some((l) => l.includes("m3")));
    assert.ok(!lines.some((l) => l.includes("m4")));
    assert.ok(lines.some((l) => l.includes("(+2 more models)")));
    assert.ok(lines.indexOf("(+2 more models)") < lines.length - 1);
  });

  it("renders the no-usage message for empty models", () => {
    const empty = summary();
    empty.models = [];
    const lines = formatUsageTable(empty);
    assert.match(lines.at(-1)!, /no logged model usage/);
  });
});

describe("buildTopModelsBlock", () => {
  it("renders an all-box top-5 block with title and rows", () => {
    const lines = buildTopModelsBlock({
      windowLabel: "7d",
      rows: [
        { model: "oc/glm-5.3-flash", spend: 33.0417 },
        { model: "oc/deepseek-v4.1-flash", spend: 6.7047 },
      ],
    });
    assert.ok(lines[0].startsWith("┌"));
    assert.match(lines[0], /Top models \(7d\)/);
    assert.ok(lines.at(-1)!.startsWith("└"));
    assert.ok(lines.some((l) => l.includes("oc/glm-5.3-flash") && l.includes("$33.04")));
    // All rows render the same width (box aligned).
    const widths = new Set(lines.map((l) => [...l].length));
    assert.equal(widths.size, 1);
  });

  it("caps rows at 5 models", () => {
    const lines = buildTopModelsBlock({
      windowLabel: "7d",
      rows: Array.from({ length: 8 }, (_, i) => ({ model: `m${i}`, spend: 1 - i / 10 })),
    });
    const dataRows = lines.filter((l) => l.includes("│") && !l.includes("Top models"));
    assert.equal(dataRows.length, 5);
  });

  it("does not mutate the input", () => {
    const rows = [{ model: "m1", spend: 1 }];
    buildTopModelsBlock({ windowLabel: "7d", rows });
    assert.equal(rows.length, 1);
  });
});

import { buildTopModelsStatusEntries, usageGauge } from "../extensions/lib/usage.ts";

describe("buildTopModelsStatusEntries", () => {
  const rows = [
    { model: "oc/glm-5.3-flash", spend: 34.59 },
    { model: "oc/deepseek-v4.1-flash", spend: 7.12 },
    { model: "oc/minimax-m3", spend: 1.65 },
    { model: "oc/kimi-k2.7-code", spend: 0.33 },
    { model: "oc/glm-5.3", spend: 0.1 },
    { model: "oc/sixth-model", spend: 0.01 },
  ];

  it("builds a title entry plus one status row per model (capped at 5)", () => {
    const entries = buildTopModelsStatusEntries({ windowLabel: "7d", rows });
    assert.equal(entries.length, 7); // title + separator + 5 rows
    assert.match(entries[0].text, /Top models \(7d\)/);
    assert.match(entries[2].text, /oc\/glm-5\.3-flash\s+\$34\.59/);
    assert.ok(!entries.some((e) => e.text.includes("sixth-model")));
  });

  it("keys sort right after the budget status key", () => {
    const entries = buildTopModelsStatusEntries({ windowLabel: "7d", rows });
    // Relative order must be: budget line first, then the title, then rows.
    const keys = entries.map((e) => e.key);
    const sorted = ["actsis-litellm:budget", ...keys].sort((a, b) => a.localeCompare(b));
    assert.equal(sorted[0], "actsis-litellm:budget");
    assert.equal(sorted[1], keys[0]);
    assert.deepEqual(sorted.slice(1), keys);
  });

  it("renders dashed rows for null spend and skips the title total when unknown", () => {
    const entries = buildTopModelsStatusEntries({
      windowLabel: "7d",
      rows: [{ model: "m", spend: null }],
    });
    assert.match(entries[2].text, /m\s+\$0\.00\s+0%/);
    assert.ok(!entries[0].text.includes("$"));
  });

  it("includes the window total in the title when provided", () => {
    const entries = buildTopModelsStatusEntries({ windowLabel: "7d", rows, totalSpend: 43.9 });
    assert.match(entries[0].text, /\$43\.90/);
  });
});


describe("buildTopModelsStatusEntries (table + gauge)", () => {
  const rows = [
    { model: "oc/glm-5.3-flash", spend: 34.59 },
    { model: "oc/ds-v4.1-flash", spend: 7.12 },
    { model: "oc/minimax-m3", spend: 1.65 },
  ];

  it("aligns model names and spends across rows", () => {
    const entries = buildTopModelsStatusEntries({ windowLabel: "7d", rows, totalSpend: 43.9 });
    const dataRows = entries.slice(2); // title + separator first
    // Tabular: the spend column starts at the same column in every row, and
    // so does the percentage/gauge tail.
    // Spend is right-aligned: the end of the $xx.xx token is the same column.
    const spendEnds = dataRows.map((e) => {
      const m = e.text.match(/\$\d+\.\d\d/);
      return m && m.index !== undefined ? m.index + m[0].length : -1;
    });
    assert.equal(new Set(spendEnds).size, 1);
    const pctEnds = dataRows.map((e) => e.text.indexOf("%"));
    assert.equal(new Set(pctEnds).size, 1);
    assert.ok(dataRows.every((e) => e.text.endsWith("▱") || e.text.endsWith("▰")));
  });

  it("adds a budget-style gauge with the share of the window total", () => {
    const entries = buildTopModelsStatusEntries({ windowLabel: "7d", rows, totalSpend: 43.9 });
    const top = entries[2].text; // title + separator first
    // 34.59 / 43.9 = 78.8% -> "79%" and mostly filled gauge.
    assert.match(top, /79% [\u25b0\u25b1]*$/);
    const gauges = entries.slice(2).map((e) => {
      const gauge = e.text.match(/([▰▱]+)$/);
      return gauge ? gauge[1] : "";
    });
    assert.equal(gauges.every((g) => [...g].length === 8), true);
    // First row's gauge has more filled cells than the last row's.
    const filled = (g: string) => [...g].filter((c) => c === "▰").length;
    assert.ok(filled(gauges[0]) > filled(gauges[gauges.length - 1]));
  });

  it("full gauge for 100% share, empty for ~0%", () => {
    const entries = buildTopModelsStatusEntries({
      windowLabel: "7d",
      rows: [
        { model: "only", spend: 10 },
        { model: "residual", spend: 0.0001 },
      ],
      totalSpend: 10.0,
    });
    const top = entries[2].text; // title + separator first
    assert.match(top, /100%/);
    const gauge = [...top].filter((c) => "▰".includes(c)).length;
    assert.equal(gauge, 8);
    const residual = entries[3].text;
    assert.match(residual, /\s0%/);
  });

  it("renders the gauge via usageGauge (8 cells, budget style)", () => {
    assert.equal(usageGauge(0), "▱".repeat(8));
    assert.equal(usageGauge(100), "▰".repeat(8));
    assert.equal([...usageGauge(50)].filter((c) => c === "▰").length, 4);
  });
});

import {
  fetchGatewayRequests,
} from "../extensions/lib/usage.ts";

describe("fetchModelUsage (dashboard-parity sources)", () => {
  it("hits the aggregated endpoint with user_id and adopts its query-scoped totals", async () => {
    const calls: string[] = [];
    const recorder = mockFetch((requestUrl) => {
      calls.push(requestUrl.pathname + requestUrl.search);
      return jsonResponse({
        results: [
          {
            date: "2026-10-09",
            metrics: { spend: 1, total_tokens: 10, api_requests: 2 },
            breakdown: {
              models: {
                "openai/x": { metrics: { spend: 1, total_tokens: 10, api_requests: 2 } },
              },
            },
          },
          {
            date: "2026-10-08",
            metrics: { spend: 2, total_tokens: 20, api_requests: 3 },
            breakdown: {
              models: {
                "openai/x": { metrics: { spend: 2, total_tokens: 20, api_requests: 3 } },
              },
            },
          },
        ],
        metadata: { total_spend: 3, total_tokens: 30, total_api_requests: 5, total_pages: 1 },
      });
    });
    try {
      const summary = await fetchModelUsage("http://gw:4000", "sk-x", 5_000, RANGE, { userId: "u-1" });
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes("/user/daily/activity/aggregated"));
      assert.ok(calls[0].includes("user_id=u-1"));
      assert.equal(summary.totals.spend, 3);
      assert.equal(summary.totals.totalTokens, 30);
      assert.equal(summary.totals.apiRequests, 5);
      assert.deepEqual(summary.models[0], {
        model: "openai/x",
        spend: 3,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 30,
        apiRequests: 5,
      });
    } finally {
      recorder.restore();
    }
  });

  it("falls back to the paginated endpoint when aggregated is unavailable, summing rows across pages", async () => {
    const calls: string[] = [];
    const recorder = mockFetch((requestUrl) => {
      const path = requestUrl.pathname + requestUrl.search;
      calls.push(path);
      if (path.includes("/aggregated")) {
        return jsonResponse({ detail: "not found" }, 404);
      }
      if (requestUrl.searchParams.get("page") === "2") {
        return jsonResponse({
          results: [
            { date: "2026-10-04", metrics: { spend: 1, total_tokens: 10, api_requests: 2 }, breakdown: { models: { "openai/y": { metrics: { spend: 1, total_tokens: 10, api_requests: 2 } } } } },
          ],
          metadata: { total_spend: 1, total_api_requests: 2 }, // page-scoped: must NOT be adopted
        });
      }
      return jsonResponse({
        results: [
          { date: "2026-10-05", metrics: { spend: 1, total_tokens: 10, api_requests: 1 }, breakdown: { models: { "openai/x": { spend: 1, total_tokens: 10, api_requests: 1 } } } },
        ],
        metadata: { total_spend: 1, total_api_requests: 1, has_more: true, total_pages: 2 },
      });
    });
    try {
      const summary = await fetchModelUsage("http://gw:4000", "sk-x", 5_000, RANGE, { userId: "u-1" });
      assert.equal(calls.filter((c) => c.startsWith("/user/daily/activity?")).length, 2);
      assert.ok(calls.some((c) => c.includes("page=2")));
      // Totals from summed rows (1+1), NOT from any single page's metadata.
      assert.equal(summary.totals.spend, 2);
      assert.equal(summary.totals.apiRequests, 3);
      assert.deepEqual(
        summary.models.map((m) => [m.model, m.spend]),
        [
          ["openai/x", 1],
          ["openai/y", 1],
        ],
      );
    } finally {
      recorder.restore();
    }
  });
});

describe("fetchGatewayRequests", () => {
  it("sums successful and failed gateway answers for the user", async () => {
    const recorder = mockFetch((requestUrl) => {
      assert.equal(requestUrl.pathname, "/gateway/daily/activity");
      assert.ok(requestUrl.searchParams.get("user_id") === "u-1");
      return jsonResponse({
        metadata: { total_successful_requests: 86_272, total_failed_requests: 527 },
        results: [],
      });
    });
    try {
      const requests = await fetchGatewayRequests("http://gw:4000", "sk-x", 5_000, RANGE, { userId: "u-1" });
      assert.deepEqual(requests, { successful: 86_272, failed: 527, total: 86_799 });
    } finally {
      recorder.restore();
    }
  });

  it("returns null when the endpoint is unavailable (old proxies)", async () => {
    const recorder = mockFetch(() => jsonResponse({ detail: "nf" }, 404));
    try {
      const requests = await fetchGatewayRequests("http://gw:4000", "sk-x", 5_000, RANGE, { userId: "u-1" });
      assert.equal(requests, null);
    } finally {
      recorder.restore();
    }
  });
});

describe("fetchGatewayRequests (top-level totals shape)", () => {
  it("reads totals at the top level when metadata omits them", async () => {
    const recorder = mockFetch((requestUrl) => {
      assert.equal(requestUrl.pathname, "/gateway/daily/activity");
      return jsonResponse({ total_successful_requests: 100, total_failed_requests: 4, results: [] });
    });
    try {
      const requests = await fetchGatewayRequests("http://gw:4000", "sk-x", 5_000, RANGE, { userId: "u-1" });
      assert.deepEqual(requests, { successful: 100, failed: 4, total: 104 });
    } finally {
      recorder.restore();
    }
  });
});

describe("buildTopModelsStatusEntries (tabulated rows)", () => {
  const rows = [
    { model: "oc/glm-5.3-flash", spend: 67.0 },
    { model: "oc/glm-5.3", spend: 30.94 },
    { model: "oc/deepseek-v4.1-flash", spend: 11.59 },
    { model: "oc/minimax-m3", spend: 2.31 },
    { model: "oc/kimi-k2.7-code", spend: 0.33 },
  ];

  it("adds an = separator entry right under the title", () => {
    const entries = buildTopModelsStatusEntries({ windowLabel: "7d", rows, totalSpend: 112.48 });
    assert.equal(entries[1].key.endsWith("0"), true);
    assert.match(entries[1].text, /^=+$/);
    assert.ok(entries[1].text.length >= 30);
  });

  it("re-keys entries so sort order is title, separator, row-1..5", () => {
    const entries = buildTopModelsStatusEntries({ windowLabel: "7d", rows, totalSpend: 112.48 });
    const keys = entries.map((e) => e.key);
    const sorted = [...keys].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(keys, sorted);
    assert.ok(keys[0].endsWith("top"));
    assert.ok(keys[1].endsWith("top0"));
    assert.ok(keys[2].endsWith("top1"));
  });

  it("aligns spend, percentage and gauge columns across rows", () => {
    const entries = buildTopModelsStatusEntries({ windowLabel: "7d", rows, totalSpend: 112.48 });
    const dataRows = entries.slice(2).map((e) => e.text);
    // Spend token ends at the same column in every row.
    const spendEnds = dataRows.map((t) => {
      const m = t.match(/\$\d+\.\d\d/);
      return m && m.index !== undefined ? m.index + m[0].length : -1;
    });
    assert.equal(new Set(spendEnds).size, 1);
    // Percentage token ends at the same column (right-aligned).
    const pctEnds = dataRows.map((t) => {
      const m = t.match(/(\d+)%/);
      return m && m.index !== undefined && m.index !== null ? m.index + m[0].length : -1;
    });
    assert.equal(new Set(pctEnds).size, 1);
    // Gauge tails align.
    assert.ok(dataRows.every((t) => /[▰▱]$/.test(t)));
    const gaugeEnds = dataRows.map((t) => t.length);
    assert.equal(new Set(gaugeEnds).size, 1);
  });

});
