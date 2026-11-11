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
  buildCancelImageHandler,
  type CommandDeps,
} from "../extensions/lib/commands.ts";
import { ImageJobRegistry } from "../extensions/lib/image-jobs.ts";

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
    // Isolate the config-file lookup: resolveConfig falls back to
    // $HOME/.pi/agent/actsis-litellm.json, which exists on this machine.
    process.env.HOME = tmpDir;
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
      prefsPath: path.join(tmpDir, `prefs-${Date.now()}.json`),
      requestTimeoutMs: 30_000,
      imageJobRegistry: new ImageJobRegistry(),
    };
  });

  describe("actsis-litellm:status", () => {
    it("shows OAuth expiry in the system timezone and preserves unavailable expiry", async (t) => {
      const originalTZ = process.env.TZ;
      t.after(() => {
        if (originalTZ === undefined) delete process.env.TZ;
        else process.env.TZ = originalTZ;
      });
      process.env.TZ = "America/Bogota";
      process.env.ACTSIS_LITELLM_URL = "https://gateway.example.com";
      t.after(() => { delete process.env.ACTSIS_LITELLM_URL; });
      for (const [expires, expected] of [
        [Date.parse("2026-10-14T03:30:00Z"), "2026-10-13 22:30 (America/Bogota, GMT-05:00)"],
        [undefined, "never"],
        [Number.NaN, "never"],
      ] as const) {
        const ctx = makeMockCtx({ modelRegistry: makeMockRegistry({
          getProviderAuth: async () => ({
            credential: { type: "oauth", expires },
          } as unknown as AuthResult),
        }) });
        await buildStatusHandler(deps)("", ctx);
        const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].level, "info");
        const lines = notifications[0].message.split("\n");
        assert.equal(
          lines.find((l) => l.startsWith("Auth:")),
          `Auth: oauth credential stored (expires ${expected})`,
        );
      }
    });

    it("notifies config-missing message when no config is resolved", async () => {
      const ctx = makeMockCtx();
      const handler = buildStatusHandler(deps);
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

    it("shows gateway URL from stored credential", async () => {
      await writeFile(
        deps.authPath,
        JSON.stringify(
          {
            "actsis-litellm": {
              type: "oauth",
              tokenEndpoint: "https://gateway.example.com/token",
              access: "a",
              refresh: "r",
            },
          },
          null,
          2,
        ),
      );
      await mkdir(path.dirname(deps.cachePath), { recursive: true });
      await writeFile(deps.cachePath, JSON.stringify({ version: 1, fetchedAt: Date.now(), models: [] }), "utf8");

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
      assert.ok(notifications[0].message.includes("Gateway: https://gateway.example.com"));
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

    // --- Identity and team lines (feature: status-identity, S1/S2/S5/S6/S7) ---

    const TEAM_ID = "ad59169e-f0c9-45a3-aa73-eec187533bdf";
    const USER_ID = "2ed0da75-556d-4c8f-99da-727d7e085fd4";
    const SECRET_TOKEN = "sk-SECRET-KEY-TOKEN";
    const GATEWAY = "https://gateway.example.com";

    function mockStatusFetch(
      impl: (url: string) => Promise<Response>,
    ): { calls: string[]; restore: () => void } {
      const originalFetch = globalThis.fetch;
      const calls: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url.replace(GATEWAY, ""));
        return impl(url);
      }) as typeof fetch;
      return {
        calls,
        restore: () => {
          globalThis.fetch = originalFetch;
        },
      };
    }

    function mockRestore(t: { after: (fn: () => void) => void }, mock: { restore: () => void }): void {
      t.after(() => mock.restore());
    }

    async function writeDeterministicCache(): Promise<void> {
      await mkdir(path.dirname(deps.cachePath), { recursive: true });
      await writeFile(
        deps.cachePath,
        JSON.stringify({
          version: 2,
          fetchedAt: Date.now() - 5 * 60_000,
          models: [],
          credential: { kind: "oauth", userId: USER_ID, teamId: TEAM_ID },
        }),
        "utf8",
      );
    }

    function oauthAuthResult(): AuthResult {
      return {
        source: "stored",
        credential: {
          type: "oauth",
          access: "tok",
          teamId: TEAM_ID,
        },
      } as unknown as AuthResult;
    }

    function apiKeyAuthResult(): AuthResult {
      return {
        source: "stored",
        auth: { apiKey: "sk-test" },
      } as unknown as AuthResult;
    }

    function registryWithAuth(authResult: AuthResult): ModelRegistry {
      return makeMockRegistry({
        getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
        getProviderAuth: async () => authResult,
        getRegisteredProviderIds: () => ["actsis-litellm"],
        getAll: () => [],
      });
    }

    function notificationsOf(ctx: ExtensionCommandContext): Array<{ message: string; level?: string }> {
      return (ctx as unknown as {
        notifications: Array<{ message: string; level?: string }>;
      }).notifications;
    }

    function requireEnvGateway(t: { after: (fn: () => void) => void }): void {
      process.env.ACTSIS_LITELLM_URL = GATEWAY;
      t.after(() => {
        delete process.env.ACTSIS_LITELLM_URL;
      });
    }

    it("shows the connected user and the connection team after the credential source and before the catalog (S1/S2/S7)", async (t) => {
      requireEnvGateway(t);
      await writeDeterministicCache();
      const mock = mockStatusFetch(async (url) => {
        if (url.endsWith("/key/info")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        if (url.endsWith("/user/info")) {
          return new Response(
            JSON.stringify({
              user_id: USER_ID,
              user_info: {
                user_email: "ricardo.pinto@actsis.com",
                user_alias: "RPINTO",
                user_role: "proxy_admin",
                teams: [TEAM_ID],
              },
              keys: [{ token: SECRET_TOKEN }],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/team/list")) {
          return new Response(
            JSON.stringify([{ team_id: TEAM_ID, team_alias: "Acceso-Completo" }]),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 404 });
      });
      mockRestore(t, mock);

      const ctx = makeMockCtx({ modelRegistry: registryWithAuth(oauthAuthResult()) });
      await buildStatusHandler(deps)("", ctx);

      const lines = notificationsOf(ctx)[0].message.split("\n");
      const userIndex = lines.findIndex((l) => l.startsWith("User:"));
      const teamIndex = lines.findIndex((l) => l.startsWith("Team:"));
      assert.ok(userIndex > lines.findIndex((l) => l.startsWith("Credential source:")));
      assert.ok(teamIndex > userIndex);
      assert.ok(teamIndex < lines.findIndex((l) => l.startsWith("Catalog:")));
      assert.equal(lines[userIndex], "User: ricardo.pinto@actsis.com (RPINTO, proxy_admin)");
      assert.equal(lines[teamIndex], `Team: Acceso-Completo (${TEAM_ID})`);
    });

    it("never leaks the raw /user/info token payload into the status and writes no identity file (S5)", async (t) => {
      requireEnvGateway(t);
      await writeDeterministicCache();
      const { readdir } = await import("node:fs/promises");
      const filesBefore = (await readdir(tmpDir)).sort();
      const mock = mockStatusFetch(async (url) => {
        if (url.endsWith("/key/info")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        if (url.endsWith("/user/info")) {
          return new Response(
            JSON.stringify({
              user_info: { user_alias: "RPINTO" },
              keys: [{ token: SECRET_TOKEN }],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/team/list")) {
          return new Response(
            JSON.stringify([{ team_id: TEAM_ID, team_alias: "Acceso-Completo" }]),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 404 });
      });
      mockRestore(t, mock);

      const ctx = makeMockCtx({ modelRegistry: registryWithAuth(oauthAuthResult()) });
      await buildStatusHandler(deps)("", ctx);

      const text = notificationsOf(ctx)[0].message;
      assert.ok(!text.includes(SECRET_TOKEN));
      assert.ok(text.includes("User: RPINTO"));
      assert.deepEqual((await readdir(tmpDir)).sort(), filesBefore);
    });

    it("resolves the team alias via /team/list with /team/info fallback and degrades to id-only (S4)", async (t) => {
      requireEnvGateway(t);
      await writeDeterministicCache();
      const mock = mockStatusFetch(async (url) => {
        if (url.endsWith("/key/info")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        if (url.endsWith("/user/info")) {
          return new Response(
            JSON.stringify({ user_info: { user_alias: "RPINTO" } }),
            { status: 200 },
          );
        }
        if (url.endsWith("/team/list")) {
          return new Response("Forbidden", { status: 403 });
        }
        if (url.endsWith("/team/info?team_id=ad59169e-f0c9-45a3-aa73-eec187533bdf")) {
          return new Response(
            JSON.stringify({ team_id: TEAM_ID, team_alias: "Acceso-Completo" }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 404 });
      });
      mockRestore(t, mock);

      const ctx = makeMockCtx({ modelRegistry: registryWithAuth(oauthAuthResult()) });
      await buildStatusHandler(deps)("", ctx);

      const lines = notificationsOf(ctx)[0].message.split("\n");
      assert.equal(lines.find((l) => l.startsWith("Team:")), `Team: Acceso-Completo (${TEAM_ID})`);
      assert.ok(mock.calls.includes("/team/list"));
      assert.ok(
        mock.calls.includes(`/team/info?team_id=${TEAM_ID}`),
        `expected /team/info fallback, got ${JSON.stringify(mock.calls)}`,
      );
    });

    it("keeps every pre-existing status line byte-identical when identity fetch fails with a network error (S6)", async (t) => {
      requireEnvGateway(t);
      await writeDeterministicCache();
      const mock = mockStatusFetch(async (url) => {
        if (url.endsWith("/key/info")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        throw new Error("boom network");
      });
      mockRestore(t, mock);

      const ctx = makeMockCtx({ modelRegistry: registryWithAuth(oauthAuthResult()) });
      await buildStatusHandler(deps)("", ctx);

      assert.equal(notificationsOf(ctx).length, 1);
      assert.equal(notificationsOf(ctx)[0].level, "info");
      assert.equal(
        notificationsOf(ctx)[0].message,
        [
          "Provider: actsis-litellm — registered",
          "Auth: oauth credential stored (expires never)",
          "Credential source: stored",
          "User: unavailable (Failed to fetch user info: boom network)",
          `Team: ${TEAM_ID} (alias unavailable)`,
          "Catalog: 0 models for provider, cache age: 5m ago",
          `Catalog scope: OAuth session (team ${TEAM_ID})`,
          "Gateway: https://gateway.example.com",
        ].join("\n"),
      );
    });

    it("reflects a 401 as the degraded reason instead of an exception (S6)", async (t) => {
      requireEnvGateway(t);
      await writeDeterministicCache();
      const mock = mockStatusFetch(async (url) => {
        if (url.endsWith("/key/info")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response("Unauthorized", { status: 401 });
      });
      mockRestore(t, mock);

      const ctx = makeMockCtx({ modelRegistry: registryWithAuth(oauthAuthResult()) });
      await buildStatusHandler(deps)("", ctx);

      const lines = notificationsOf(ctx)[0].message.split("\n");
      assert.equal(
        lines.find((l) => l.startsWith("User:")),
        "User: unavailable (Credential rejected by gateway. Run /login again.)",
      );
      assert.equal(lines.find((l) => l.startsWith("Team:")), `Team: ${TEAM_ID} (alias unavailable)`);
      // Pre-existing lines stay byte-identical.
      assert.equal(lines[0], "Provider: actsis-litellm — registered");
      assert.equal(lines[1], "Auth: oauth credential stored (expires never)");
      assert.equal(lines.find((l) => l.startsWith("Gateway:")), "Gateway: https://gateway.example.com");
    });

    it("reports User/Team no credential and performs no network call without a usable credential (S1/S2)", async (t) => {
      requireEnvGateway(t);
      const mock = mockStatusFetch(async () => {
        throw new Error("must not be called");
      });
      mockRestore(t, mock);

      const ctx = makeMockCtx({
        modelRegistry: makeMockRegistry({
          getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
          getProviderAuth: async () => undefined,
          getRegisteredProviderIds: () => ["actsis-litellm"],
          getAll: () => [],
        }),
      });
      await buildStatusHandler(deps)("", ctx);

      const lines = notificationsOf(ctx)[0].message.split("\n");
      assert.equal(lines.find((l) => l.startsWith("User:")), "User: no credential");
      assert.equal(lines.find((l) => l.startsWith("Team:")), "Team: no credential");
      assert.deepEqual(mock.calls, []);
    });

    it("reports User: no credential with no usable token, and Team: none (no team bound) for an API-key credential (S1/S2)", async (t) => {
      requireEnvGateway(t);
      const mock = mockStatusFetch(async (url) => {
        if (url.endsWith("/key/info")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        if (url.endsWith("/user/info")) {
          return new Response(
            JSON.stringify({ user_info: { user_alias: "RPINTO" } }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 404 });
      });
      mockRestore(t, mock);

      const ctx = makeMockCtx({ modelRegistry: registryWithAuth(apiKeyAuthResult()) });
      await buildStatusHandler(deps)("", ctx);

      const lines = notificationsOf(ctx)[0].message.split("\n");
      assert.equal(lines.find((l) => l.startsWith("Auth:")), "Auth: credential stored");
      assert.equal(lines.find((l) => l.startsWith("User:")), "User: RPINTO");
      assert.equal(lines.find((l) => l.startsWith("Team:")), "Team: none (no team bound)");
      assert.ok(!lines.some((l) => l.startsWith("Budget:")));
    });
  });

  describe("actsis-litellm:models", () => {
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

  describe("actsis-litellm:logout", () => {
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

  describe("actsis-litellm:cancel-image (T5)", () => {
    it("cancels all active jobs and reports them", async () => {
      const registry = deps.imageJobRegistry!;
      const j1 = registry.create("sdxl-pixel-art", "512x512");
      registry.start(j1.id);
      const j2 = registry.create("sdxl-pixel-art", "768x768");
      registry.start(j2.id);
      const ctx = makeMockCtx();
      await buildCancelImageHandler(deps)("all", ctx);
      const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].level, "info");
      assert.match(notifications[0].message, /Aborted image renders/);
      assert.match(notifications[0].message, new RegExp(j1.id));
      assert.match(notifications[0].message, new RegExp(j2.id));
      assert.match(notifications[0].message, /may keep running on the gateway GPU/);
      assert.equal(j1.controller.signal.aborted, true);
      assert.equal(j2.controller.signal.aborted, true);
    });

    it("reports no jobs when cancel-all has nothing to abort", async () => {
      const ctx = makeMockCtx();
      await buildCancelImageHandler(deps)("all", ctx);
      const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].level, "info");
      assert.match(notifications[0].message, /No image renders in flight/);
    });

    it("cancels a specific job id and reports it", async () => {
      const registry = deps.imageJobRegistry!;
      const job = registry.create("sdxl-pixel-art", "512x512");
      registry.start(job.id);
      const ctx = makeMockCtx();
      await buildCancelImageHandler(deps)(job.id, ctx);
      const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].level, "info");
      assert.match(notifications[0].message, new RegExp(job.id));
      assert.match(notifications[0].message, /may keep running on the gateway GPU/);
      assert.equal(job.controller.signal.aborted, true);
    });

    it("warns when the requested job id is not active", async () => {
      const ctx = makeMockCtx();
      await buildCancelImageHandler(deps)("img-99", ctx);
      const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].level, "warning");
      assert.match(notifications[0].message, /No active image render/);
    });

    it("warns when called without an argument", async () => {
      const ctx = makeMockCtx();
      await buildCancelImageHandler(deps)("", ctx);
      const notifications = (ctx as unknown as { notifications: Array<{ message: string; level?: string }> }).notifications;
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].level, "warning");
      assert.match(notifications[0].message, /Usage/);
    });
  });
});
