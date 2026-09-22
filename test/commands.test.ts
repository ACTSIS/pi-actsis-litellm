import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import type { ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AuthResult, Model, Api } from "@earendil-works/pi-ai";
import {
  buildStatusHandler,
  buildModelsCommandHandler,
  buildLogoutHandler,
  type CommandDeps,
} from "../extensions/lib/commands.ts";

type MutableMockRegistry = Record<string, unknown>;

function makeMockRegistry(base: Record<string, unknown> = {}): ModelRegistry {
  const registry: Record<string, unknown> = {
    runtime: {} as unknown,
    refresh: async () => ({ aborted: false, errors: new Map() }),
    getAll: () => [] as Model<Api>[],
    getAvailable: () => [] as Model<Api>[],
    find: () => undefined,
    hasConfiguredAuth: () => false,
    getApiKeyAndHeaders: async () => ({ ok: false, error: "mock" }),
    getProvider: () => undefined,
    stream: () => { throw new Error("mock"); },
    streamSimple: () => { throw new Error("mock"); },
    complete: async () => { throw new Error("mock"); },
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
    modelRegistry: makeMockRegistry((overrides.modelRegistry as unknown as Record<string, unknown>) ?? {}),
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
    getSystemPromptOptions: () => ({} as ReturnType<ExtensionCommandContext["getSystemPromptOptions"]>),
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

describe("commands", () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let deps: CommandDeps;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-cmd-test-"));
    originalEnv = { ...process.env };
    delete process.env.ACTSIS_LITELLM_URL;
  });

  after(async () => {
    process.env = originalEnv;
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    deps = {
      getState: () => ({ providerId: "actsis-litellm" }),
      cachePath: path.join(tmpDir, `cache-${Date.now()}.json`),
      authPath: path.join(tmpDir, `auth-${Date.now()}.json`),
      requestTimeoutMs: 30_000,
    };
  });

  describe("litellm:status", () => {
    it("notifies config-missing message when no config is resolved", async () => {
      const ctx = makeMockCtx();
      const handler = buildStatusHandler(deps);
      await handler("", ctx);

      const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].level, "warning");
      assert.ok(
        notifications[0].message.includes(
          "Gateway URL not configured. Set ACTSIS_LITELLM_URL or use /login to configure.",
        ),
      );
    });

    it("reports no credential when auth is absent", async () => {
      process.env.ACTSIS_LITELLM_URL = "https://gateway.example.com";

      const ctx = makeMockCtx({
        modelRegistry: makeMockRegistry({
          getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
          getProviderAuth: async () => undefined,
          getRegisteredProviderIds: () => ["actsis-litellm"],
          getAll: () => [],
      }),
      });

      const handler = buildStatusHandler(deps);
      await handler("", ctx);

      const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
      assert.equal(notifications.length, 1);
      const text = notifications[0].message.replace(/\u2014/g, "--");
      assert.ok(text.includes("Provider: actsis-litellm -- registered"));
      assert.ok(text.includes("Auth: no credential"));
      assert.ok(text.includes("Gateway: https://gateway.example.com"));
    });
  });

  describe("litellm:models", () => {
    it("refreshes and reports the filtered model count", async () => {
      const refreshCalls: Array<unknown> = [];
      const ctx = makeMockCtx({
        modelRegistry: makeMockRegistry({
          refresh: async (options: unknown) => {
            refreshCalls.push(options);
            return { aborted: false, errors: new Map() };
          },
          getAll: () =>
            [
              { provider: "actsis-litellm", id: "m1" },
              { provider: "other", id: "x" },
            ] as Model<Api>[],
      }),
      });

      const handler = buildModelsCommandHandler(deps);
      await handler("", ctx);

      assert.equal(refreshCalls.length, 1);
      assert.deepEqual(refreshCalls[0], {
        allowNetwork: true,
        providers: ["actsis-litellm"],
        force: true,
      });

      const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
      assert.equal(notifications.length, 2);
      assert.equal(notifications[0].message, "Syncing model catalog from gateway...");
      assert.ok(notifications[1].message.includes("1 models available"));
    });

    it("notifies error without throwing when refresh fails", async () => {
      const ctx = makeMockCtx({
        modelRegistry: makeMockRegistry({
          refresh: async () => {
            throw new Error("network down");
          },
      }),
      });

      const handler = buildModelsCommandHandler(deps);
      await handler("", ctx);

      const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
      const errors = notifications.filter((n) => n.level === "error");
      assert.equal(errors.length, 1);
      assert.ok(errors[0].message.includes("network down"));
    });
  });

  describe("litellm:logout", () => {
    it("notifies when there are no stored credentials", async () => {
      const ctx = makeMockCtx({
        modelRegistry: makeMockRegistry({
          getProviderAuth: async () => undefined,
      }),
      });

      const handler = buildLogoutHandler(deps);
      await handler("", ctx);

      const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].level, "warning");
      assert.ok(notifications[0].message.includes("No stored credentials for actsis-litellm"));
    });

    it("does not crash when auth.json is missing", async () => {
      const ctx = makeMockCtx({
        modelRegistry: makeMockRegistry({
          getProviderAuth: async () => undefined,
      }),
      });

      const handler = buildLogoutHandler(deps);
      await handler("", ctx);

      const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
      assert.equal(notifications.length, 1);
    });

    it("clears local credential and cache without network revocation when discovery extras are missing", async () => {
      await writeFile(
        deps.authPath,
        JSON.stringify(
          {
            "actsis-litellm": {
              type: "oauth",
              access: "a",
              refresh: "r",
              expires: Date.now() + 3600_000,
            },
            other: { type: "api_key", key: "k" },
          },
          null,
          2,
        ),
      );
      await mkdir(path.dirname(deps.cachePath), { recursive: true });
      await writeFile(deps.cachePath, JSON.stringify({ version: 1, fetchedAt: Date.now(), models: [] }), "utf8");

      const ctx = makeMockCtx({
        modelRegistry: makeMockRegistry({
          getProviderAuth: async () =>
            ({
              credential: {
                type: "oauth",
                access: "a",
                refresh: "r",
                expires: Date.now() + 3600_000,
              },
            } as unknown as AuthResult),
      }),
      });

      const handler = buildLogoutHandler(deps);
      await handler("", ctx);

      const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].level, "info");
      assert.ok(notifications[0].message.includes("Logged out"));
    });
  });
});
