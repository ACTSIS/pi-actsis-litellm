import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import type { ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  buildUsageHandler,
  defaultCommandDeps,
  extractUsableApiKey,
  type CommandDeps,
} from "../extensions/lib/commands.ts";
import { readStoredCredentialUserId } from "../extensions/lib/gateway-url.ts";

function makeMockRegistry(overrides: Record<string, unknown> = {}): ModelRegistry {
  const base: Record<string, unknown> = {
    getAll: () => [],
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
    getRegisteredProviderIds: () => [],
    getError: () => undefined,
  };
  for (const [k, v] of Object.entries(overrides)) base[k] = v;
  return base as unknown as ModelRegistry;
}

function makeMockCtx(
  overrides: { modelRegistry?: ModelRegistry } = {},
): ExtensionCommandContext & { notifications: Array<{ message: string; level?: string }> } {
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
    sessionManager: {},
    modelRegistry: overrides.modelRegistry ?? makeMockRegistry(),
    model: undefined,
    getScopedModels: () => [],
    getSystemPrompt: () => "",
    notifications,
  };
  return ctx as unknown as ExtensionCommandContext & {
    notifications: Array<{ message: string; level?: string }>;
  };
}

describe("extractUsableApiKey", () => {
  it("reads pi auth resolution first (auth.apiKey covers OAuth and API keys)", () => {
    assert.equal(extractUsableApiKey({ auth: { apiKey: "resolved-key" } }), "resolved-key");
  });

  it("falls back to the oauth credential access token", () => {
    assert.equal(
      extractUsableApiKey({
        credential: { type: "oauth", access: "access-token" },
      }),
      "access-token",
    );
  });

  it("falls back to a raw access field (synthesized api key credentials)", () => {
    assert.equal(extractUsableApiKey({ access: "raw-key" }), "raw-key");
  });

  it("returns null for undefined/empty results", () => {
    assert.equal(extractUsableApiKey(undefined), null);
    assert.equal(extractUsableApiKey({}), null);
    assert.equal(extractUsableApiKey({ auth: { apiKey: "" } }), null);
  });
});

describe("actsis-litellm:usage credential wiring", () => {
  let deps: CommandDeps;
  let home: string;

  before(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "usage-cred-"));
    deps = defaultCommandDeps();
    deps.authPath = path.join(home, "auth.json");
    deps.cachePath = path.join(home, "cache.json");
    // Config resolution needs a stored credential gateway URL (auth.json) or
    // env; auth.json covers both config resolution and the bearer key path.
    await mkdir(path.dirname(deps.authPath), { recursive: true });
    await writeFile(
      deps.authPath,
      JSON.stringify({
        "actsis-litellm": {
          type: "oauth",
          access: "stored-access",
          refresh: "stored-refresh",
          expires: Date.now() + 3_600_000,
          userId: "u-1234",
          gatewayUrl: "https://gateway.example.com",
          tokenEndpoint: "https://gateway.example.com/token",
          revocationEndpoint: "https://gateway.example.com/revoke",
          resource: "https://gateway.example.com",
        },
        "other": {
          type: "oauth",
          access: "other-access",
          refresh: "other-refresh",
          expires: Date.now() + 3_600_000,
          tokenEndpoint: "https://other.example.com/token",
        },
      }),
      "utf8",
    );
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
    delete process.env.ACTSIS_LITELLM_URL;
  });

  it("fetches usage using auth.apiKey from pi auth resolution", async () => {
    const seenAuth: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/user/daily/activity") {
        const request = new Request(String(input), init);
        seenAuth.push(request.headers.get("authorization") ?? "(none)");
        return new Response(
          JSON.stringify({
            results: [
              {
                date: "2025-03-26",
                metrics: { spend: 0.01, prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, api_requests: 2 },
                breakdown: { models: { "m-a": { spend: 0.01, prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, api_requests: 2 } } },
              },
            ],
            metadata: { total_spend: 0.01, total_tokens: 30, total_api_requests: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const ctx = makeMockCtx({
        modelRegistry: makeMockRegistry({
          getProviderAuth: async () => ({ auth: { apiKey: "resolved-key" }, source: "stored" }),
        }),
      });
      const handler = buildUsageHandler(deps);
      await handler("", ctx);
      assert.equal(seenAuth.length, 1);
      assert.equal(seenAuth[0], "Bearer resolved-key");
      assert.equal(ctx.notifications.length, 1);
      assert.equal(ctx.notifications[0].level, "info");
      assert.match(ctx.notifications[0].message, /m-a/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not report missing credential when auth.apiKey is present", async () => {
    const ctx = makeMockCtx({
      modelRegistry: makeMockRegistry({
        getProviderAuth: async () => ({ auth: { apiKey: "k" } }),
      }),
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [], metadata: {} }), {
        status: 200,
      })) as typeof fetch;
    try {
      const handler = buildUsageHandler(deps);
      await handler("1", ctx);
      assert.equal(ctx.notifications.length, 1);
      assert.equal(ctx.notifications[0].level, "info");
      assert.match(ctx.notifications[0].message, /no logged model usage/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("still warns when the auth result carries no usable key", async () => {
    const ctx = makeMockCtx({
      modelRegistry: makeMockRegistry({
        getProviderAuth: async () => ({ auth: {} }),
      }),
    });
    const handler = buildUsageHandler(deps);
    await handler("", ctx);
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].level, "warning");
    assert.match(ctx.notifications[0].message, /No usable credential/);
  });

  describe("readStoredCredentialUserId", () => {
    it("reads userId from the stored credential entry", async () => {
      const uid = await readStoredCredentialUserId(deps.authPath, "actsis-litellm");
      assert.equal(uid, "u-1234");
    });

    it("returns null when missing or for another provider", async () => {
      assert.equal(await readStoredCredentialUserId(deps.authPath, "other"), null);
      assert.equal(
        await readStoredCredentialUserId(path.join(home, "missing-auth.json"), "actsis-litellm"),
        null,
      );
    });
  });
});
