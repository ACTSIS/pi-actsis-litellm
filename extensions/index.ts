import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConfigFileShape, ActsisEnabledConfig } from "./lib/config.ts";
import {
  buildProviderConfig,
  defaultAuthPath,
} from "./lib/provider.ts";
import { ConfigError } from "./lib/errors.ts";
import { resolveConfig } from "./lib/config.ts";
import { readStoredCredentialGatewayUrl } from "./lib/gateway-url.ts";
import {
  buildStatusHandler,
  buildModelsCommandHandler,
  buildLogoutHandler,
  buildUsageHandler,
  defaultCommandDeps,
  extractUsableApiKey,
} from "./lib/commands.ts";
import { normalizeOverflowError } from "./lib/overflow.ts";
import {
  normalizeLimitError,
  budgetUsagePercent,
} from "./lib/limit-errors.ts";
import { fetchBudgetInfo, type BudgetInfo } from "./lib/budget.ts";
import {
  applyModelAliases,
  buildTopModelsBlock,
  fetchModelUsage,
  mapModelAliases,
  resolveUsageRangeDays,
} from "./lib/usage.ts";
import { configureSystemCa } from "./lib/tls-config.ts";

export interface LiteLLMExtensionState {
  providerId?: string;
  loggedIn?: boolean;
  lastError?: string;
  catalogCount?: number;
}

// Shared mutable state for T6 commands.
const state: LiteLLMExtensionState = {};

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
const TOP_MODELS_WIDGET_KEY = "actsis-litellm:top-models";
const TOP_MODELS_TTL_MS = 5 * 60 * 1000;
const TOP_MODELS_WINDOW_DAYS = 7;

interface TopModelsCache {
  fetchedAtMs: number;
  block: string[];
}
let topModelsCache: TopModelsCache | null = null;
const GAUGE_CELLS = 8;
const GAUGE_FILLED = "▰";
const GAUGE_EMPTY = "▱";

function budgetGauge(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * GAUGE_CELLS);
  return GAUGE_FILLED.repeat(filled) + GAUGE_EMPTY.repeat(GAUGE_CELLS - filled);
}

function budgetStatusText(info: BudgetInfo): string | undefined {
  if (info.spend === null) return undefined;
  const spend = `$${info.spend.toFixed(2)}`;
  if (info.maxBudget !== null && info.maxBudget > 0) {
    const percent = budgetUsagePercent(info.spend, info.maxBudget);
    const cap = `$${info.maxBudget.toFixed(2)}`;
    return `Budget ${budgetGauge(percent)} ${Math.round(percent)}% · ${spend}/${cap}`;
  }
  return `Budget ${spend} used (no cap)`;
}

async function refreshBudgetWidget(ctx: WidgetContext): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;

  try {
    const providerId = state.providerId;
    if (!providerId) {
      ctx.ui.setWidget("actsis-litellm-budget", undefined);
      return "no provider registered";
    }

    const authResult = await ctx.modelRegistry.getProviderAuth(providerId);
    const apiKey =
      authResult &&
      typeof authResult === "object" &&
      "auth" in authResult &&
      typeof (authResult as { auth?: { apiKey?: unknown } }).auth?.apiKey === "string"
        ? ((authResult as { auth: { apiKey: string } }).auth.apiKey as string)
        : undefined;
    if (!apiKey) {
      ctx.ui.setWidget("actsis-litellm-budget", undefined);
      return "no auth resolution (auth.apiKey missing)";
    }

    const baseUrl = await getBaseUrl();
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

    const info = await fetchBudgetInfo(baseUrl, apiKey, cfg.requestTimeoutMs);
    const text = budgetStatusText(info);
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

async function refreshTopModelsWidget(
  ctx: WidgetContext,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!ctx.hasUI) return;

  const nowMs = Date.now();
  if (
    !options.force &&
    topModelsCache &&
    nowMs - topModelsCache.fetchedAtMs < TOP_MODELS_TTL_MS
  ) {
    return; // cached block still fresh
  }

  const render = (block: string[], fetchedAtMs: number): void => {
    topModelsCache = { fetchedAtMs, block };
    ctx.ui.setWidget(TOP_MODELS_WIDGET_KEY, block, { placement: "belowEditor" });
  };
  const clear = (): void => {
    topModelsCache = null;
    ctx.ui.setWidget(TOP_MODELS_WIDGET_KEY, undefined, { placement: "belowEditor" });
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
    const summary = await fetchModelUsage(
      baseUrl,
      apiKey,
      cfg.requestTimeoutMs,
      range,
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
      buildTopModelsBlock({
        windowLabel: "7d",
        rows: display.models.map((m) => ({ model: m.model, spend: m.spend })),
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

  pi.registerCommand("actsis-litellm:status", {
    description: "Show LiteLLM gateway status and model cache state",
    handler: buildStatusHandler(commandDeps),
  });

  pi.registerCommand("actsis-litellm:models", {
    description: "Force-sync LiteLLM model catalog and show changes",
    handler: buildModelsCommandHandler(commandDeps),
  });

  pi.registerCommand("actsis-litellm:usage", {
    description:
      "Show per-model usage (spend/tokens/requests); args: [days] or 'YYYY-MM-DD .. YYYY-MM-DD'",
    handler: buildUsageHandler(commandDeps),
  });

  pi.registerCommand("actsis-litellm:logout", {
    description: "Revoke LiteLLM credentials and clear local state",
    handler: buildLogoutHandler(commandDeps),
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
