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
      assert.equal(requestUrl.pathname, "/user/daily/activity");
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
          "http://gw.example:4000/user/daily/activity",
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
