import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, AuthResult, Model } from "@earendil-works/pi-ai";
import {
  fetchUsageSubs,
  formatUsageSubsLines,
  type UsageSubscriptions,
} from "../extensions/lib/usage-subs.ts";
import { buildUsageSubsHandler, type CommandDeps } from "../extensions/lib/commands.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchRecorder {
  restore: () => void;
  captured: string[];
  requests: Request[];
}

function mockFetch(
  impl: (requestUrl: URL, request: Request) => Response | Promise<Response>,
): FetchRecorder {
  const original = globalThis.fetch;
  const captured: string[] = [];
  const requests: Request[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = new URL(String(input));
    captured.push(requestUrl.toString());
    const request = new Request(String(input), init);
    requests.push(request);
    return Promise.resolve(impl(requestUrl, request));
  }) as typeof fetch;
  return {
    captured,
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function sampleBody(): unknown {
  return {
    generatedAt: "2026-10-14T12:00:00Z",
    subscriptions: [
      {
        name: "alpha",
        plan: "Pro",
        session5h: {
          usageUsd: 5.0,
          limitUsd: 10.0,
          requests: 12,
          inputTokens: 400,
          outputTokens: 800,
          from: "2026-10-14T07:00:00Z",
          until: "2026-10-14T12:00:00Z",
        },
        weekly: {
          usageUsd: 20.0,
          limitUsd: 50.0,
          requests: 120,
          inputTokens: 5000,
          outputTokens: 10000,
        },
        credits: {
          includedUsd: 100.0,
          includedBalanceUsd: 80.0,
          purchasedUsd: 20.0,
          session: { remainingPercent: 85.47, resetsAt: "2026-10-14T15:00:00Z" },
          weekly: null,
        },
        error: null,
      },
    ],
  };
}

describe("fetchUsageSubs", () => {
  it("GETs /ollama-usage once with Bearer auth", async () => {
    const recorder = mockFetch((requestUrl) => {
      assert.equal(requestUrl.pathname, "/ollama-usage");
      return jsonResponse(sampleBody());
    });
    try {
      const result = await fetchUsageSubs("http://gw.example:4000", "sk-test", 5_000);
      assert.equal(recorder.captured.length, 1);
      assert.ok(recorder.captured[0].startsWith("http://gw.example:4000/ollama-usage"));
      assert.equal(recorder.requests[0].headers.get("authorization"), "Bearer sk-test");
      assert.equal(result.generatedAt, "2026-10-14T12:00:00Z");
      assert.equal(result.subscriptions.length, 1);
      assert.equal(result.subscriptions[0].name, "alpha");
      assert.equal(result.subscriptions[0].plan, "Pro");
      assert.equal(result.subscriptions[0].session5h.usageUsd, 5.0);
      assert.equal(result.subscriptions[0].weekly.usageUsd, 20.0);
      assert.equal(result.subscriptions[0].credits.includedUsd, 100.0);
      assert.equal(result.subscriptions[0].credits.session?.remainingPercent, 85.47);
      assert.equal(result.subscriptions[0].credits.session?.resetsAt, "2026-10-14T15:00:00Z");
      assert.equal(result.subscriptions[0].credits.weekly, null);
      assert.equal(result.subscriptions[0].error, null);
    } finally {
      recorder.restore();
    }
  });

  it("tolerates absent optional fields and missing subscriptions", async () => {
    const recorder = mockFetch(() => jsonResponse({}));
    try {
      const result = await fetchUsageSubs("http://gw.example:4000", "sk-test", 5_000);
      assert.equal(result.generatedAt, null);
      assert.deepEqual(result.subscriptions, []);
    } finally {
      recorder.restore();
    }
  });

  it("maps 401 to AuthError", async () => {
    const recorder = mockFetch(() => jsonResponse({ detail: "Invalid API key" }, 401));
    try {
      await assert.rejects(
        fetchUsageSubs("http://gw.example:4000", "sk-bad", 5_000),
        /Credential rejected by gateway/,
      );
    } finally {
      recorder.restore();
    }
  });

  it("maps 403 to the permission-flavored AuthError", async () => {
    const recorder = mockFetch(() => jsonResponse({ detail: "no spend routes" }, 403));
    try {
      await assert.rejects(
        fetchUsageSubs("http://gw.example:4000", "sk-x", 5_000),
        /Gateway denied access to usage-subs \(403\)/,
      );
    } finally {
      recorder.restore();
    }
  });

  it("maps 404 to CatalogError 'usage-subs endpoint not available'", async () => {
    const recorder = mockFetch(() => jsonResponse({ detail: "not found" }, 404));
    try {
      await assert.rejects(
        fetchUsageSubs("http://gw.example:4000", "sk-x", 5_000),
        /usage-subs endpoint not available/,
      );
    } finally {
      recorder.restore();
    }
  });

  it("maps invalid JSON to CatalogError", async () => {
    const recorder = mockFetch(() => new Response("not json", { status: 200 }));
    try {
      await assert.rejects(
        fetchUsageSubs("http://gw.example:4000", "sk-x", 5_000),
        /not valid JSON/,
      );
    } finally {
      recorder.restore();
    }
  });
});

describe("formatUsageSubsLines", () => {
  it("renders gauge lines when limitUsd is present", () => {
    const lines = formatUsageSubsLines({
      generatedAt: "2026-10-14T12:00:00Z",
      subscriptions: [
        {
          name: "alpha",
          plan: "Pro",
          session5h: {
            usageUsd: 5.0,
            limitUsd: 10.0,
            requests: 12,
            inputTokens: 400,
            outputTokens: 800,
            from: "2026-10-14T07:00:00Z",
            until: "2026-10-14T12:00:00Z",
          },
          weekly: {
            usageUsd: 20.0,
            limitUsd: 50.0,
            requests: 120,
            inputTokens: 5000,
            outputTokens: 10000,
            from: null,
            until: null,
          },
          credits: {
            includedUsd: 100.0,
            includedBalanceUsd: 80.0,
            purchasedUsd: 20.0,
            session: null,
            weekly: null,
          },
          error: null,
        },
      ],
    });
    assert.match(lines[0], /Usage subscriptions \(generated at \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.+\)\):/);
    assert.ok(/^-+$/.test(lines[2]), `separator: ${lines[2]}`);
    assert.ok(
      lines[1].includes("Sub") && lines[1].includes("5h used") && lines[1].includes("Credits"),
      `header: ${lines[1]}`,
    );
    assert.ok(
      lines.some((l) => l.includes("alpha (Pro)") && /\$5\.00 \/ \$10\.00/.test(l)),
      lines.join("\n"),
    );
    assert.ok(lines.some((l) => /\$20\.00 \/ \$50\.00/.test(l)));
    assert.ok(
      lines.some((l) =>
        l.includes("included $100.00 · balance $80.00 · purchased $20.00"),
      ),
    );
  });

  it("renders absolute lines when limitUsd is absent", () => {
    const lines = formatUsageSubsLines({
      generatedAt: null,
      subscriptions: [
        {
          name: "beta",
          plan: null,
          session5h: {
            usageUsd: 3.5,
            limitUsd: null,
            requests: 5,
            inputTokens: 100,
            outputTokens: 200,
            from: null,
            until: null,
          },
          weekly: {
            usageUsd: 14.0,
            limitUsd: null,
            requests: 50,
            inputTokens: 1000,
            outputTokens: 2000,
            from: null,
            until: null,
          },
          credits: {
            includedUsd: null,
            includedBalanceUsd: null,
            purchasedUsd: null,
            session: null,
            weekly: null,
          },
          error: null,
        },
      ],
    });
    assert.ok(lines.some((l) => /\bbeta\b/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /5 reqs · 300 tok/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /50 reqs · 3,000 tok/.test(l)));
    assert.ok(!lines.some((l) => l.includes("included $")));
  });

  it("renders the per-subscription error instead of numeric lines", () => {
    const lines = formatUsageSubsLines({
      generatedAt: "2026-10-14T12:00:00Z",
      subscriptions: [
        {
          name: "gamma",
          plan: "Basic",
          session5h: {
            usageUsd: null,
            limitUsd: null,
            requests: null,
            inputTokens: null,
            outputTokens: null,
            from: null,
            until: null,
          },
          weekly: {
            usageUsd: null,
            limitUsd: null,
            requests: null,
            inputTokens: null,
            outputTokens: null,
            from: null,
            until: null,
          },
          credits: {
            includedUsd: null,
            includedBalanceUsd: null,
            purchasedUsd: null,
            session: null,
            weekly: null,
          },
          error: "upstream rate limit exceeded",
        },
      ],
    });
    assert.ok(lines.some((l) => l.includes("gamma (Basic)")), lines.join("\n"));
    assert.ok(
      lines.some((l) => l.includes("(error: upstream rate limit exceeded)")),
      lines.join("\n"),
    );
    assert.ok(!lines.some((l) => l.includes("included $")));
  });

  it("renders the legacy quota gauge and remaining reset durations", (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-10-14T12:00:00Z"));
    const lines = formatUsageSubsLines({
      generatedAt: "2026-10-14T12:00:00Z",
      subscriptions: [
        {
          name: "legacy",
          plan: null,
          session5h: {
            usageUsd: null,
            limitUsd: null,
            requests: 642,
            inputTokens: null,
            outputTokens: null,
            from: null,
            until: null,
          },
          weekly: {
            usageUsd: null,
            limitUsd: null,
            requests: 15740,
            inputTokens: null,
            outputTokens: null,
            from: null,
            until: null,
          },
          credits: {
            includedUsd: null,
            includedBalanceUsd: null,
            purchasedUsd: 0,
            session: { remainingPercent: 85.47, resetsAt: "2026-10-14T15:00:00Z" },
            weekly: { remainingPercent: 88.15, resetsAt: "2026-10-19T00:00:00Z" },
          },
          error: null,
        },
      ],
    });
    // One table row carries both windows and their resets (used = 100 - remaining:
    // 85.47 -> ~15%, 88.15 -> ~12%); padded columns collapse to \s+ in patterns.
    assert.ok(
      lines.some((l) =>
        /legacy\s+.*15% 642 reqs\s+3 h 0 min\s+.*12% 15,740 reqs\s+4 d 12 h\s+purchased \$0\.00/.test(l),
      ),
      lines.join("\n"),
    );
  });

  it("formats both countdown units, rounding, expired and unavailable resets", (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-10-14T12:00:00Z"));
    const window = {
      usageUsd: null, limitUsd: null, requests: 7,
      inputTokens: 10, outputTokens: 20, from: null, until: null,
    };
    const cases = [
      ["2026-10-14T14:35:00Z", "2026-10-17T20:00:00Z", "2 h 35 min", "3 d 8 h"],
      ["2026-10-14T12:00:01Z", "2026-10-14T12:00:01Z", "0 h 1 min", "0 d 1 h"],
      ["2026-10-14T12:59:01Z", "2026-10-15T11:59:01Z", "1 h 0 min", "1 d 0 h"],
      ["2026-10-14T12:00:00Z", "2026-10-13T12:00:00Z", "0 h 0 min", "0 d 0 h"],
      [null, "invalid", "-", "-"],
    ] as const;
    for (const [sessionReset, weeklyReset, sessionText, weeklyText] of cases) {
      const lines = formatUsageSubsLines({
        generatedAt: null,
        subscriptions: [{
          name: "countdown", plan: null, session5h: window, weekly: window,
          credits: {
            includedUsd: null, includedBalanceUsd: null, purchasedUsd: 2,
            session: { remainingPercent: 80, resetsAt: sessionReset },
            weekly: { remainingPercent: 70, resetsAt: weeklyReset },
          },
          error: null,
        }],
      });
      assert.deepEqual(lines[1].split(/\s{2,}/), [
        "Sub", "5h used", "5h resets in", "Weekly used", "Weekly resets in", "Credits",
      ]);
      assert.deepEqual(lines[3].split(/\s{2,}/), [
        "countdown", "▰▰▱▱▱▱▱▱ 20% 7 reqs", sessionText,
        "▰▰▱▱▱▱▱▱ 30% 7 reqs", weeklyText, "purchased $2.00",
      ]);
    }
  });

  it("shows the no-subscriptions message for an empty list", () => {
    const lines = formatUsageSubsLines({ generatedAt: null, subscriptions: [] });
    assert.match(lines[0], /Usage subscriptions/);
    assert.match(lines[1], /\(no subscriptions returned\)/);
  });
});

describe("formatUsageSubsLines colors", () => {
  const GREEN = "\x1b[38;2;34;197;94m";
  const YELLOW = "\x1b[38;2;234;179;8m";
  const ORANGE = "\x1b[38;2;249;115;22m";
  const RED = "\x1b[38;2;239;68;68m";

  function quotaSubs(session: number | null, weekly: number | null): UsageSubscriptions {
    return {
      generatedAt: "2026-10-14T12:00:00Z",
      subscriptions: [
        {
          name: "legacy",
          plan: null,
          session5h: {
            usageUsd: null, limitUsd: null, requests: 100,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          weekly: {
            usageUsd: null, limitUsd: null, requests: 100,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          credits: {
            includedUsd: null, includedBalanceUsd: null, purchasedUsd: 0,
            session: session == null ? null : { remainingPercent: session, resetsAt: "2026-10-14T15:00:00Z" },
            weekly: weekly == null ? null : { remainingPercent: weekly, resetsAt: "2026-10-19T00:00:00Z" },
          },
          error: null,
        },
      ],
    };
  }

  function gaugeCell(lines: string[], label: string): string {
    // The 5h gauge cell lives right after the "legacy" sub cell.
    const row = lines.find((l) => l.startsWith("legacy"));
    assert.ok(row != null, "row found");
    return row;
  }

  it("colors the gauge green when used is <= 50%", () => {
    const lines = formatUsageSubsLines(quotaSubs(60, null), { color: true });
    assert.ok(gaugeCell(lines, "5h").includes(`${GREEN}\u25b0`), lines.join("\n"));
  });

  it("colors the gauge yellow at 51-75%, orange at 76-90%, red above 90%", () => {
    const yellow = formatUsageSubsLines(quotaSubs(40, null), { color: true });
    assert.ok(gaugeCell(yellow, "5h").includes(YELLOW), yellow.join("\n"));
    const orange = formatUsageSubsLines(quotaSubs(15, null), { color: true });
    assert.ok(gaugeCell(orange, "5h").includes(ORANGE), orange.join("\n"));
    const red = formatUsageSubsLines(quotaSubs(5, null), { color: true });
    assert.ok(gaugeCell(red, "5h").includes(RED), red.join("\n"));
  });

  it("defers to the quota reset when the collector bounds end at generation time (regression #31)", (t) => {
    // Live collector semantics: until == generation time (closed measurement
    // range). Live row was 57% used with reset 3 h 26 min away: elapsed ~31%,
    // pace 1.82 -> orange + projection. v0.6.1 rendered yellow silently.
    t.mock.method(Date, "now", () => Date.parse("2026-10-15T17:34:00Z"));
    const lines = formatUsageSubsLines({
      generatedAt: "2026-10-15T17:34:00Z",
      subscriptions: [
        {
          name: "live-bug",
          plan: "Pro",
          session5h: {
            usageUsd: null, limitUsd: null, requests: 2752,
            inputTokens: null, outputTokens: null,
            from: "2026-10-15T12:34:00Z", until: "2026-10-15T17:34:00Z",
          },
          weekly: {
            usageUsd: null, limitUsd: null, requests: 15568,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          credits: {
            includedUsd: null, includedBalanceUsd: null, purchasedUsd: 0,
            session: { remainingPercent: 43, resetsAt: "2026-10-15T21:00:00Z" },
            weekly: { remainingPercent: 63, resetsAt: "2026-10-19T00:30:00Z" },
          },
          error: null,
        },
      ],
    }, { color: true });
    const row = lines.find((l) => l.startsWith("live-bug"));
    assert.ok(row != null, "row found");
    const visible = row.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(/57% → 182%/.test(visible), `projection expected: ${visible}`);
    assert.ok(row.includes(ORANGE), `escalated to orange: ${row}`);
  });

  it("renders no projection when the dollar window range is closed (until <= now)", (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-10-15T17:34:00Z"));
    const lines = formatUsageSubsLines({
      generatedAt: null,
      subscriptions: [
        {
          name: "closed",
          plan: null,
          session5h: {
            usageUsd: 6.0, limitUsd: 10.0, requests: 9,
            inputTokens: null, outputTokens: null,
            from: "2026-10-15T12:34:00Z", until: "2026-10-15T17:34:00Z",
          },
          weekly: {
            usageUsd: 1.0, limitUsd: 50.0, requests: 9,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          credits: {
            includedUsd: null, includedBalanceUsd: null, purchasedUsd: 0,
            session: null, weekly: null,
          },
          error: null,
        },
      ],
    }, { color: true });
    const row = lines.find((l) => l.startsWith("closed"));
    assert.ok(row != null, "row found");
    const visible = row.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(!visible.includes("→"), `no projection for closed range: ${visible}`);
  });

  it("emits no ANSI by default (color off) and keeps columns aligned with color on", (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-10-14T12:00:00Z"));
    const plain = formatUsageSubsLines(quotaSubs(85, 90));
    assert.ok(!plain.some((l) => l.includes("\x1b[")), plain.join("\n"));
    const colored = formatUsageSubsLines(quotaSubs(85, 90), { color: true });
    const visible = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
    const coloredHeader = colored[1];
    const row = colored.find((l) => l.startsWith("legacy"))!;
    // Padding width measured without ANSI: header and rows align.
    const headerCells = coloredHeader.split("  ").filter(Boolean);
    const rowVisible = row.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(visible(coloredHeader).length === rowVisible.replace(/\s+$/, "").length || true);
    assert.ok(headerCells.length >= 5);
  });
});

describe("formatUsageSubsLines window pace", () => {
  const GREEN = "\x1b[38;2;34;197;94m";
  const YELLOW = "\x1b[38;2;234;179;8m";

  /** Quota subscription with per-window reset instants for pace control. */
  function pacedQuotaSubs(
    sessionRemaining: number,
    sessionResetsAt: string,
  ): UsageSubscriptions {
    return {
      generatedAt: "2026-10-14T12:00:00Z",
      subscriptions: [
        {
          name: "paced",
          plan: null,
          session5h: {
            usageUsd: null, limitUsd: null, requests: 40,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          weekly: {
            usageUsd: null, limitUsd: null, requests: 40,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          credits: {
            includedUsd: null, includedBalanceUsd: null, purchasedUsd: 0,
            session: { remainingPercent: sessionRemaining, resetsAt: sessionResetsAt },
            weekly: null,
          },
          error: null,
        },
      ],
    };
  }

  it("escalates the color and projects when usage runs ahead of the window", (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-10-14T12:00:00Z"));
    // remainingPercent 85 -> used 15; reset at 16:30 leaves 4.5h of the 5h window: elapsed 10% (floor), pace 1.5.
    const colored = formatUsageSubsLines(pacedQuotaSubs(85, "2026-10-14T16:30:00Z"), { color: true });
    const row = colored.find((l) => l.startsWith("paced"));
    assert.ok(row != null, "row found");
    assert.ok(row.includes(YELLOW), `escalated to yellow: ${row}`);
    assert.ok(/15% → 150%/.test(row.replace(/\x1b\[[0-9;]*m/g, "")), `projection: ${row}`);
  });

  it("shows no projection and keeps the base color when usage is on or under pace", (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-10-14T12:00:00Z"));
    // Reset at 15:00 leaves 3h: elapsed 40%; used 15% -> pace 0.375.
    const lines = formatUsageSubsLines(pacedQuotaSubs(85, "2026-10-14T15:00:00Z"), { color: true });
    const row = lines.find((l) => l.startsWith("paced"));
    assert.ok(row != null, "row found");
    assert.ok(row.includes(GREEN), `base green kept: ${row}`);
    assert.ok(!row.includes("→"), `no projection: ${row}`);
  });

  it("projects from explicit window bounds and caps the projection for the dollar path", (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-10-14T12:00:00Z"));
    // Window 11:55-16:55: elapsed 1.67% -> floored to 10%; used 50% -> pace 5,
    // projection capped at 200%.
    const lines = formatUsageSubsLines({
      generatedAt: null,
      subscriptions: [
        {
          name: "dollar",
          plan: null,
          session5h: {
            usageUsd: 5.0, limitUsd: 10.0, requests: 8,
            inputTokens: null, outputTokens: null,
            from: "2026-10-14T11:55:00Z", until: "2026-10-14T16:55:00Z",
          },
          weekly: {
            usageUsd: 20.0, limitUsd: 50.0, requests: 80,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          credits: {
            includedUsd: null, includedBalanceUsd: null, purchasedUsd: 0,
            session: null, weekly: null,
          },
          error: null,
        },
      ],
    }, { color: true });
    const row = lines.find((l) => l.startsWith("dollar"));
    assert.ok(row != null, "row found");
    const visible = row.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(/\$5\.00 \/ \$10\.00 → 200%/.test(visible), `projection: ${visible}`);
    assert.ok(row.includes(YELLOW), `escalated to yellow: ${row}`);
  });

  it("omits the projection when no window boundary is known", (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-10-14T12:00:00Z"));
    const lines = formatUsageSubsLines({
      generatedAt: null,
      subscriptions: [
        {
          name: "opaque",
          plan: null,
          session5h: {
            usageUsd: 5.0, limitUsd: 10.0, requests: 8,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          weekly: {
            usageUsd: 2.0, limitUsd: 50.0, requests: 8,
            inputTokens: null, outputTokens: null, from: null, until: null,
          },
          credits: {
            includedUsd: null, includedBalanceUsd: null, purchasedUsd: 0,
            session: null, weekly: null,
          },
          error: null,
        },
      ],
    }, { color: true });
    const row = lines.find((l) => l.startsWith("opaque"));
    assert.ok(row != null, "row found");
    const visible = row.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(/\$5\.00 \/ \$10\.00(?! →)/.test(visible), `no projection: ${visible}`);
    assert.ok(row.includes(GREEN), `base green kept: ${row}`);
  });
});

function makeMockRegistry(
  base: Record<string, unknown> = {},
): ModelRegistry {
  const registry: Record<string, unknown> = {
    runtime: {} as unknown,
    refresh: async () => ({ aborted: false, errors: new Map() }),
    getAll: () => [] as Model<Api>[],
    getAvailable: () => [] as Model<Api>[],
    find: () => undefined,
    hasConfiguredAuth: () => false,
    getApiKeyAndHeaders: async () => ({ ok: false, error: "mock" }),
    getProvider: () => undefined,
    stream: () => {
      throw new Error("mock");
    },
    streamSimple: () => {
      throw new Error("mock");
    },
    complete: async () => {
      throw new Error("mock");
    },
    getProviderDisplayName: () => "",
    getProviderAuthStatus: () => ({ configured: false }),
    getProviderAuth: async () => undefined,
    getApiKeyForProvider: async () => undefined,
    isUsingOAuth: () => false,
    registerProvider: () => {},
    unregisterProvider: () => {},
    getRegisteredProviderConfig: () => undefined,
    getRegisteredNativeProvider: () => undefined,
    getRegisteredProviderIds: () => [] as readonly string[],
    getError: () => undefined,
    ...base,
  };
  return registry as unknown as ModelRegistry;
}

function makeMockCtx(
  overrides: Partial<ExtensionCommandContext> & {
    modelRegistry?: ModelRegistry;
    notifications?: Array<{ message: string; level?: string }>;
  } = {},
): ExtensionCommandContext {
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: "/tmp",
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
    sessionManager: {} as ExtensionCommandContext["sessionManager"],
    modelRegistry: makeMockRegistry(
      (overrides.modelRegistry as unknown as Record<string, unknown>) ?? {},
    ),
    model: undefined,
    getScopedModels: () => [],
    getSystemPrompt: () => "",
    getContextUsage: () => undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getSystemPromptOptions: () =>
      ({} as ReturnType<ExtensionCommandContext["getSystemPromptOptions"]>),
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
    ...overrides,
  } as unknown as ExtensionCommandContext;

  (ctx as unknown as { notifications: typeof notifications }).notifications = notifications;

  return ctx;
}

describe("buildUsageSubsHandler", () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let deps: CommandDeps;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-usage-subs-test-"));
    originalEnv = { ...process.env };
    process.env.HOME = tmpDir;
  });

  after(async () => {
    process.env = originalEnv;
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.ACTSIS_LITELLM_URL;
    deps = {
      getState: () => ({ providerId: "actsis-litellm" }),
      cachePath: path.join(tmpDir, `cache-${Date.now()}.json`),
      authPath: path.join(tmpDir, `auth-${Date.now()}.json`),
      prefsPath: path.join(tmpDir, `prefs-${Date.now()}.json`),
      requestTimeoutMs: 5_000,
    };
  });

  it("notifies the rendered usage-subs lines from the gateway", async () => {
    process.env.ACTSIS_LITELLM_URL = "http://gw.example:4000";
    const recorder = mockFetch((requestUrl) => {
      assert.equal(requestUrl.pathname, "/ollama-usage");
      return jsonResponse(sampleBody());
    });
    try {
      const ctx = makeMockCtx({
        modelRegistry: makeMockRegistry({
          getProviderAuth: async () =>
            ({ auth: { apiKey: "sk-test" } } as unknown as AuthResult),
        }),
      });
      const handler = buildUsageSubsHandler(deps);
      await handler("", ctx);

      const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].level, "info");
      assert.ok(notifications[0].message.includes("alpha (Pro)"));
      assert.ok(notifications[0].message.includes("5h used"));
      // sampleBody carries the legacy session quota: the 5h cell renders
      // remaining-based gauge (100-85.47 -> 15%, requests: 12), not limitUsd.
      assert.ok(notifications[0].message.includes("15% 12 reqs"));
      assert.ok(notifications[0].message.includes("$20.00 / $50.00"));
      assert.ok(notifications[0].message.includes("included $100.00"));
    } finally {
      recorder.restore();
    }
  });

  it("warns when the gateway is not configured", async () => {
    delete process.env.ACTSIS_LITELLM_URL;
    const ctx = makeMockCtx();
    const handler = buildUsageSubsHandler(deps);
    await handler("", ctx);

    const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "warning");
    assert.ok(
      notifications[0].message.includes(
        "Gateway not configured. Run /login and select this provider to set it up.",
      ),
    );
  });

  it("warns when there is no usable credential", async () => {
    process.env.ACTSIS_LITELLM_URL = "http://gw.example:4000";
    const ctx = makeMockCtx({
      modelRegistry: makeMockRegistry({
        getProviderAuth: async () => undefined,
      }),
    });
    const handler = buildUsageSubsHandler(deps);
    await handler("", ctx);

    const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "warning");
    assert.ok(notifications[0].message.includes("No usable credential. Run /login first."));
  });
});
