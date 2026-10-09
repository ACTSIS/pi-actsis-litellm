import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchModelUsage,
  formatUsageLines,
  isoDay,
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