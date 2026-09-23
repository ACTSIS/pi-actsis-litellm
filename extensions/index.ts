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
  defaultCommandDeps,
} from "./lib/commands.ts";
import { normalizeOverflowError } from "./lib/overflow.ts";
import {
  normalizeLimitError,
  budgetUsagePercent,
} from "./lib/limit-errors.ts";
import { fetchBudgetInfo, type BudgetInfo } from "./lib/budget.ts";

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

async function refreshBudgetWidget(ctx: WidgetContext): Promise<void> {
  if (!ctx.hasUI) return;

  try {
    const providerId = state.providerId;
    if (!providerId) {
      ctx.ui.setWidget("actsis-litellm-budget", undefined);
      return;
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
      return;
    }

    const baseUrl = await getBaseUrl();
    if (!baseUrl) {
      ctx.ui.setWidget("actsis-litellm-budget", undefined);
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

    const info = await fetchBudgetInfo(baseUrl, apiKey, cfg.requestTimeoutMs);
    const text = budgetStatusText(info);
    if (text) {
      ctx.ui.setStatus?.(BUDGET_STATUS_KEY, text);
    } else {
      ctx.ui.setStatus?.(BUDGET_STATUS_KEY, undefined);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.ui.setStatus?.(BUDGET_STATUS_KEY, `Budget unavailable: ${reason}`);
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

  pi.registerCommand("actsis-litellm:logout", {
    description: "Revoke LiteLLM credentials and clear local state",
    handler: buildLogoutHandler(commandDeps),
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
      return { message: limitRewrite as unknown as AssistantMessage };
    }

    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify("pi-actsis-litellm loaded", "info");
    }
    await refreshBudgetWidget(ctx as unknown as WidgetContext);
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
