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
    assert.match(lines[0], /Usage subscriptions \(generated at 2026-10-14T12:00:00Z, UTC\):/);
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

  it("renders the legacy quota gauge and resets from remaining_percent", () => {
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
        /legacy\s+.*15% 642 reqs\s+10-14 15:00\s+.*12% 15,740 reqs\s+10-19 00:00\s+purchased \$0\.00/.test(l),
      ),
      lines.join("\n"),
    );
  });

  it("shows the no-subscriptions message for an empty list", () => {
    const lines = formatUsageSubsLines({ generatedAt: null, subscriptions: [] });
    assert.match(lines[0], /Usage subscriptions/);
    assert.match(lines[1], /\(no subscriptions returned\)/);
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
