import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConfigFileShape, ActsisEnabledConfig } from "./lib/config.ts";
import {
  buildProviderConfig,
  defaultAuthPath,
} from "./lib/provider.ts";
import { ConfigError } from "./lib/errors.ts";
import { resolveConfig } from "./lib/config.ts";
import { readStoredCredentialGatewayUrl, readStoredCredentialUserId } from "./lib/gateway-url.ts";
import {
  buildStatusHandler,
  buildModelsCommandHandler,
  buildLogoutHandler,
  getProviderId,
  resolveStatusConfig,
  buildUsageHandler,
  buildUsageSubsHandler,
  buildImageCommandHandler,
  defaultCommandDeps,
  extractUsableApiKey,
  buildTopHandler,
  readTopModelsWidgetEnabled,
} from "./lib/commands.ts";
import { IMAGE_CUSTOM_TYPE } from "./lib/image.ts";
import { imageMessageRenderer } from "./lib/image-renderer.ts";
import {
  buildGenerateImageTool,
  discoverImageModels,
  ImageSessionStore,
} from "./lib/image-tool.ts";
import { normalizeOverflowError } from "./lib/overflow.ts";
import {
  normalizeLimitError,
} from "./lib/limit-errors.ts";
import { fetchBudgetInfo, formatBudgetStatusText, type BudgetInfo } from "./lib/budget.ts";
import {
  applyModelAliases,
  buildTopModelsStatusEntries,
  fetchModelUsage,
  mapModelAliases,
  resolveUsageRangeDays,
  TOP_MODELS_STATUS_KEY_PREFIX,
} from "./lib/usage.ts";
import { configureSystemCa } from "./lib/tls-config.ts";

export interface LiteLLMExtensionState {
  providerId?: string;
  loggedIn?: boolean;
  lastError?: string;
  catalogCount?: number;
}

// Shared mutable state for T6 commands. Exported for tests only.
export const state: LiteLLMExtensionState = {};

let configNoticeWired = false;

function isOAuthCredential(
  credential: unknown,
): credential is { type: "oauth"; access: string } {
  return (
    typeof credential === "object" &&
    credential !== null &&
    (credential as Record<string, unknown>).type === "oauth" &&
    typeof (credential as Record<string, unknown>).access === "string"
  );
}

async function getBaseUrl(): Promise<string | null> {
  try {
    const storedUrl = await readStoredCredentialGatewayUrl(
      defaultAuthPath(),
      state.providerId ?? "actsis-litellm",
    );
    const cfg = await resolveConfig({
      env: process.env,
      storedUrl,
      fileLoader: async (filePath) => {
        try {
          const { readFile } = await import("node:fs/promises");
          const raw = await readFile(filePath, "utf8");
          return JSON.parse(raw) as ConfigFileShape;
        } catch {
          return null;
        }
      },
      prompt: async () => undefined,
    });
    return cfg.baseUrl;
  } catch {
    return null;
  }
}

interface WidgetContext {
  modelRegistry: {
    getProviderAuth(providerId: string): Promise<unknown>;
    getAll?(providerId?: string): Array<{ provider?: string; id?: string }>;
  };
  ui: {
    setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
    setStatus?(key: string, text: string | undefined): void;
  };
  hasUI: boolean;
}

// Shared gauge glyphs with gentle-pi's shell (▰ filled / ▱ empty, 8 cells),
// re-implemented locally so this extension renders the same visual language
// without importing or depending on gentle-pi being installed.
const BUDGET_STATUS_KEY = "actsis-litellm:budget";
// Legacy belowEditor block from the first version of the top-models widget;
// cleared on every refresh so the stale footer block disappears after update.
const TOP_MODELS_LEGACY_WIDGET_KEY = "actsis-litellm:top-models";
const TOP_MODELS_TTL_MS = 5 * 60 * 1000;
const TOP_MODELS_WINDOW_DAYS = 7;
const TOP_MODELS_MAX_ROWS = 5;

interface TopModelsCache {
  fetchedAtMs: number;
  keys: string[];
}
let topModelsCache: TopModelsCache | null = null;
let topModelsPrefsPath: string | null = null;

function prefsPathDefault(): string {
  return path.join(os.homedir(), ".pi", "agent", "actsis-litellm-prefs.json");
}

/** Test seams for refreshBudgetWidget: overrides that skip config resolution. */
interface BudgetWidgetRefreshOptions {
  baseUrl?: string;
  requestTimeoutMs?: number;
}

export async function refreshBudgetWidget(
  ctx: WidgetContext,
  options: BudgetWidgetRefreshOptions = {},
): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;

  try {
    const providerId = state.providerId;
    if (!providerId) {
      ctx.ui.setWidget("actsis-litellm-budget", undefined);
      return "no provider registered";
    }

    const authResult = await ctx.modelRegistry.getProviderAuth(providerId);
    // One shared resolution with /status and the rest of the commands
    // (extractUsableApiKey): auth.apiKey covers API-key and OAuth shapes;
    // the oauth credential's access token and a raw access field are the
    // fallbacks. The previous inline extraction read only auth.apiKey and
    // silently dropped OAuth/SSO credentials from the widget and /budget.
    const apiKey = extractUsableApiKey(authResult);
    if (!apiKey) {
      ctx.ui.setWidget("actsis-litellm-budget", undefined);
      return "no auth resolution (no usable credential — run /login)";
    }

    let baseUrl: string | null;
    let requestTimeoutMs: number;
    if (options.baseUrl && options.requestTimeoutMs !== undefined) {
      baseUrl = options.baseUrl;
      requestTimeoutMs = options.requestTimeoutMs;
    } else {
      baseUrl = await getBaseUrl();
      if (!baseUrl) {
        ctx.ui.setWidget("actsis-litellm-budget", undefined);
        return "gateway URL not resolved";
      }

      const storedUrl = await readStoredCredentialGatewayUrl(
        defaultAuthPath(),
        providerId,
      );
      const cfg = await resolveConfig({
        env: process.env,
        fileLoader: async (filePath) => {
          try {
            const { readFile } = await import("node:fs/promises");
            const raw = await readFile(filePath, "utf8");
            return JSON.parse(raw) as ConfigFileShape;
          } catch {
            return null;
          }
        },
        storedUrl,
        prompt: async () => undefined,
      });
      requestTimeoutMs = cfg.requestTimeoutMs;
    }

    const info = await fetchBudgetInfo(baseUrl, apiKey, requestTimeoutMs);
    const text = formatBudgetStatusText(info, { color: true });
    if (text) {
      ctx.ui.setStatus?.(BUDGET_STATUS_KEY, text);
      return text;
    }
    ctx.ui.setStatus?.(BUDGET_STATUS_KEY, undefined);
    return "no spend data (spend null)";
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.ui.setStatus?.(BUDGET_STATUS_KEY, `Budget unavailable: ${reason}`);
    return `error: ${reason}`;
  }
}

async function clearTopModelRows(ctx: WidgetContext): Promise<void> {
  // Remove every entry the last render may have created, plus all prior key
  // schemes and the legacy belowEditor block from previous widget versions.
  const staleKeys = [
    TOP_MODELS_LEGACY_WIDGET_KEY,
    ...(topModelsCache?.keys ?? []),
    ...Array.from({ length: TOP_MODELS_MAX_ROWS + 3 }, (_, i) => `${TOP_MODELS_STATUS_KEY_PREFIX}-${i}`),
    ...Array.from({ length: TOP_MODELS_MAX_ROWS + 3 }, (_, i) => `${TOP_MODELS_STATUS_KEY_PREFIX}${i}`),
  ];
  for (const key of new Set(staleKeys)) {
    ctx.ui.setStatus?.(key, undefined);
  }
  ctx.ui.setWidget(TOP_MODELS_LEGACY_WIDGET_KEY, undefined, { placement: "belowEditor" });
  topModelsCache = null;
}

async function refreshTopModelsWidget(
  ctx: WidgetContext,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!ctx.hasUI) return;

  if (!(await readTopModelsWidgetEnabled(topModelsPrefsPath ?? prefsPathDefault()))) {
    await clearTopModelRows(ctx);
    return; // user disabled the widget: no fetch, no render
  }

  const nowMs = Date.now();
  if (
    !options.force &&
    topModelsCache &&
    nowMs - topModelsCache.fetchedAtMs < TOP_MODELS_TTL_MS
  ) {
    return; // cached block still fresh
  }

  const render = (entries: Array<{ key: string; text: string }>, fetchedAtMs: number): void => {
    topModelsCache = { fetchedAtMs, keys: entries.map((e) => e.key) };
    for (const entry of entries) {
      ctx.ui.setStatus?.(entry.key, entry.text);
    }
  };
  const clear = async (): Promise<void> => {
    await clearTopModelRows(ctx);
  };

  try {
    const providerId = state.providerId;
    if (!providerId) {
      clear();
      return;
    }

    const authResult = await ctx.modelRegistry.getProviderAuth(providerId);
    const apiKey = extractUsableApiKey(authResult);
    if (!apiKey) {
      clear();
      return;
    }

    const baseUrl = await getBaseUrl();
    if (!baseUrl) {
      clear();
      return;
    }

    const storedUrl = await readStoredCredentialGatewayUrl(
      defaultAuthPath(),
      providerId,
    );
    const cfg = await resolveConfig({
      env: process.env,
      fileLoader: async (filePath) => {
        try {
          const { readFile } = await import("node:fs/promises");
          const raw = await readFile(filePath, "utf8");
          return JSON.parse(raw) as ConfigFileShape;
        } catch {
          return null;
        }
      },
      storedUrl,
      prompt: async () => undefined,
    });

    const range = resolveUsageRangeDays(TOP_MODELS_WINDOW_DAYS, nowMs);
    const storedUserId = await readStoredCredentialUserId(defaultAuthPath(), providerId);
    const summary = await fetchModelUsage(
      baseUrl,
      apiKey,
      cfg.requestTimeoutMs,
      range,
      { userId: storedUserId ?? undefined },
    );
    if (summary.models.length === 0 || (summary.totals.spend ?? 0) <= 0) {
      clear();
      return;
    }

    // Public names, same mapping the /usage command shows.
    const publicIds = (ctx.modelRegistry.getAll?.() ?? [])
      .filter((m) => m.provider === providerId)
      .map((m) => m.id ?? "")
      .filter((id) => id.length > 0);
    const display = applyModelAliases(
      summary,
      mapModelAliases(
        summary.models.map((m) => m.model),
        publicIds,
      ),
    );

    render(
      buildTopModelsStatusEntries({
        windowLabel: "7d",
        rows: display.models.map((m) => ({ model: m.model, spend: m.spend })),
        totalSpend: display.totals.spend,
      }),
      nowMs,
    );
  } catch {
    // The top-models block is informative: any failure clears it silently;
    // the next trigger retries after the TTL.
    clear();
  }
}

async function resolveStartupConfig(): Promise<ActsisEnabledConfig | null> {
  const storedUrl = await readStoredCredentialGatewayUrl(
    defaultAuthPath(),
    state.providerId ?? "actsis-litellm",
  );
  try {
    return await resolveConfig({
      env: process.env,
      fileLoader: async (filePath) => {
        try {
          const { readFile } = await import("node:fs/promises");
          const raw = await readFile(filePath, "utf8");
          return JSON.parse(raw) as ConfigFileShape;
        } catch {
          return null;
        }
      },
      storedUrl,
      prompt: async () => undefined,
    });
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}

async function createFileLoader(): Promise<
  (path: string) => Promise<ConfigFileShape | null>
> {
  return async (filePath: string): Promise<ConfigFileShape | null> => {
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as ConfigFileShape;
    } catch {
      return null;
    }
  };
}

export default async function actsisLiteLLMExtension(pi: ExtensionAPI) {
  // TLS bootstrap FIRST: private-CA gateways must be reachable before any
  // catalog refresh, login discovery, or chat request fires. Strictly
  // additive, fail-open, and once per session; opt-out via
  // ACTSIS_LITELLM_NO_SYSTEM_CA=1. Never blocks or throws.
  try {
    // TLS bootstrap BEFORE registration: private-CA gateways must be
    // reachable before any catalog refresh, login discovery, or chat request
    // fires. configureSystemCa is strictly additive over Node's bundled CAs
    // (public HTTPS keeps working), fail-open, and once per session. Opt-out
    // via ACTSIS_LITELLM_NO_SYSTEM_CA=1. It never rejects; the catch is
    // belt-and-braces so a TLS problem can never prevent registration.
    await configureSystemCa({
      onceKey: "actsis-litellm-extension",
      optOutEnv: process.env.ACTSIS_LITELLM_NO_SYSTEM_CA,
    });
  } catch {
    // Unreachable today; keep the guard so startup can never depend on TLS.
  }

  // Register commands first; they work independently of provider registration.
  const commandDeps = defaultCommandDeps();
  commandDeps.getState = () => state;
  // /image renders its result as a displayed custom message (issue #47 S2);
  // the pipeline is UI-owned so the handler stays testable without pi.
  commandDeps.sendMessage = (message) => {
    pi.sendMessage(message);
  };
  pi.registerMessageRenderer(IMAGE_CUSTOM_TYPE, imageMessageRenderer);

  // Model-callable image tool (issue #47 v2; specs in odd/tasks/agent-image-tool.md)
  // — natural image generation/editing from chat. The tool description is
  // refreshed (S2) with the gateway's DISCOVERED image models, never hardcoded.
  const imageStore = new ImageSessionStore();
  const imageToolDeps = {
    getProviderId: () => getProviderId(commandDeps),
    authPath: commandDeps.authPath,
    requestTimeoutMs: commandDeps.requestTimeoutMs,
    imageSaveDir: commandDeps.imageSaveDir,
    store: imageStore,
    sendMessage: (message: unknown) => {
      pi.sendMessage(message as Parameters<typeof pi.sendMessage>[0]);
    },
    resolveStatusConfig,
    getUsableApiKey: async (providerId: string, ctx: unknown): Promise<string | null> => {
      const registry = (ctx as {
        modelRegistry?: { getProviderAuth?(providerId: string): Promise<unknown> };
      }).modelRegistry;
      if (!registry?.getProviderAuth) return null;
      const authResult = await registry.getProviderAuth(providerId);
      return extractUsableApiKey(authResult);
    },
  };
  pi.registerTool(buildGenerateImageTool(imageToolDeps));

  // S2 dynamic description: re-register (replace) throttled with the
  // DISCOVERED image models; on any failure the current registration stays.
  let imageModelsCache: { ids: string[]; ts: number } = { ids: [], ts: 0 };
  pi.on("before_agent_start", async (_event, ctx) => {
    if (Date.now() - imageModelsCache.ts < 300_000) return;
    try {
      const providerId = getProviderId(commandDeps);
      const cfg = await resolveStatusConfig(providerId, commandDeps.authPath);
      if (!cfg) return;
      const authResult = await ctx.modelRegistry.getProviderAuth(providerId);
      const apiKey = extractUsableApiKey(authResult);
      if (!apiKey) return;
      const options = await discoverImageModels(cfg.baseUrl, apiKey);
      const ids = options.map((o) => o.id);
      imageModelsCache = { ids, ts: Date.now() };
      if (ids.length > 0) {
        pi.registerTool(buildGenerateImageTool({ ...imageToolDeps, descriptionModels: ids }));
      }
    } catch {
      // Catalog unreachable: keep the current description (calls discover live).
    }
  });
  topModelsPrefsPath = commandDeps.prefsPath;

  pi.registerCommand("actsis-litellm:status", {
    description: "Show LiteLLM gateway status and cache state (dates in system timezone)",
    handler: buildStatusHandler(commandDeps),
  });

  pi.registerCommand("actsis-litellm:models", {
    description: "Force-sync LiteLLM model catalog and show changes",
    handler: buildModelsCommandHandler(commandDeps),
  });

  pi.registerCommand("actsis-litellm:usage", {
    description:
      "Show per-model usage (spend/tokens/requests, UTC date ranges); args: [days] or 'YYYY-MM-DD .. YYYY-MM-DD'",
    handler: buildUsageHandler(commandDeps),
  });

  pi.registerCommand("actsis-litellm:usage-subs", {
    description:
      "Show per-subscription Ollama Cloud usage (system-local generation date; reset countdowns: 5h hours/minutes, weekly days/hours)",
    handler: buildUsageSubsHandler(commandDeps),
  });

  pi.registerCommand("actsis-litellm:image", {
    description:
      "Generate a pixel-art image (sdxl-pixel-art) and render it in the session; usage: /image <prompt> [--size 512|768|1024]",
    handler: buildImageCommandHandler(commandDeps),
  });

  pi.registerCommand("actsis-litellm:logout", {
    description: "Revoke LiteLLM credentials and clear local state",
    handler: buildLogoutHandler(commandDeps),
  });

  pi.registerCommand("actsis-litellm:top", {
    description: "Toggle the Top-5 models widget (7 UTC days; no args = toggle; on | off)",
    handler: async (args: string, ctx: unknown) => {
      const commandCtx = ctx as ExtensionCommandContext;
      await buildTopHandler(commandDeps)(args, commandCtx);
      if (!(await readTopModelsWidgetEnabled(commandDeps.prefsPath))) {
        // Disable: no fetch, no rows, no notifications from the refresh.
        await clearTopModelRows(commandCtx as unknown as WidgetContext);
      } else {
        // Enable: show rows right away.
        await refreshTopModelsWidget(commandCtx as unknown as WidgetContext, { force: true });
      }
    },
  });

  pi.registerCommand("actsis-litellm:budget", {
    description: "Force a budget refresh and report the outcome",
    handler: async (_args: string, ctx: unknown) => {
      const outcome = await refreshBudgetWidget(ctx as WidgetContext);
      await refreshTopModelsWidget(ctx as unknown as WidgetContext, { force: true });
      if (ctx && typeof ctx === "object" && "hasUI" in ctx && (ctx as { hasUI?: boolean }).hasUI) {
        const ui = (ctx as { ui?: { notify?(message: string, level?: string): void } }).ui;
        ui?.notify?.(`Budget refresh: ${outcome ?? "ok"}`, "info");
      }
    },
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message as {
      role: string;
      stopReason?: string;
      errorMessage?: string;
      provider?: string;
    };

    const overflowRewrite = normalizeOverflowError(
      state.providerId,
      message,
      ctx?.model?.provider,
    );
    if (overflowRewrite) {
      // Budget widget refresh is only relevant when this is not an overflow,
      // but refresh reactively on any 429 classification is handled next.
      return { message: overflowRewrite as unknown as AssistantMessage };
    }

    const limitRewrite = normalizeLimitError(
      state.providerId,
      message,
      ctx?.model?.provider,
    );
    if (limitRewrite) {
      await refreshBudgetWidget(ctx as unknown as WidgetContext);
      await refreshTopModelsWidget(ctx as unknown as WidgetContext);
      return { message: limitRewrite as unknown as AssistantMessage };
    }

    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify("pi-actsis-litellm loaded", "info");
    }
    await refreshBudgetWidget(ctx as unknown as WidgetContext);
    await refreshTopModelsWidget(ctx as unknown as WidgetContext);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await refreshBudgetWidget(ctx as unknown as WidgetContext);
    await refreshTopModelsWidget(ctx as unknown as WidgetContext);
  });

  async function registerWithConfig(providerId: string): Promise<void> {
    const fileLoader = await createFileLoader();
    const storedUrl = await readStoredCredentialGatewayUrl(
      defaultAuthPath(),
      providerId,
    );
    const cfg = await resolveConfig({
      env: process.env,
      fileLoader,
      storedUrl,
      prompt: async () => undefined,
    });
    const providerConfig = await buildProviderConfig(cfg);
    pi.registerProvider(cfg.providerId, providerConfig);
    state.providerId = cfg.providerId;
    state.catalogCount = providerConfig.models.length;
  }

  function buildOnLoginSuccess(fallbackId: string): {
    onLoginSuccess: (gatewayUrl: string) => Promise<void>;
  } {
    return {
      onLoginSuccess: async (_gatewayUrl) => {
        try {
          await registerWithConfig(state.providerId ?? fallbackId);
        } catch (err) {
          // Non-fatal: login already succeeded, re-registration is best-effort.
          if (err instanceof ConfigError && !configNoticeWired) {
            configNoticeWired = true;
            pi.on("session_start", async (_event, ctx) => {
              if (ctx.hasUI) {
                ctx.ui.notify(
                  "pi-actsis-litellm: run /login to configure the gateway",
                  "info",
                );
              }
            });
          }
        }
      },
    };
  }

  async function registerBestEffort(): Promise<void> {
    const cfg = await resolveStartupConfig();
    if (cfg) {
      const providerConfig = await buildProviderConfig(
        cfg,
        buildOnLoginSuccess(cfg.providerId),
      );
      pi.registerProvider(cfg.providerId, providerConfig);
      state.providerId = cfg.providerId;
      state.catalogCount = providerConfig.models.length;
      return;
    }

    // No URL configured yet: register a placeholder so /login still works.
    // R3-001 fix: the placeholder MUST receive onLoginSuccess so a login
    // performed through it re-registers the provider with the real URL.
    const placeholderConfig = await buildProviderConfig(
      null,
      buildOnLoginSuccess("actsis-litellm"),
    );
    pi.registerProvider("actsis-litellm", placeholderConfig);
    state.providerId = "actsis-litellm";

    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "pi-actsis-litellm: run /login to configure the gateway",
          "info",
        );
      }
    });
  }

  await registerBestEffort();
}
