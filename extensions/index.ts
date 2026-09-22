import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConfigFileShape } from "./lib/config.ts";
import { buildProviderConfig } from "./lib/provider.ts";
import { ConfigError } from "./lib/errors.ts";
import { resolveConfig } from "./lib/config.ts";
import {
  buildStatusHandler,
  buildModelsCommandHandler,
  buildLogoutHandler,
  defaultCommandDeps,
} from "./lib/commands.ts";
import { normalizeOverflowError } from "./lib/overflow.ts";

export interface LiteLLMExtensionState {
  providerId?: string;
  loggedIn?: boolean;
  lastError?: string;
  catalogCount?: number;
}

// Shared mutable state for T6 commands.
const state: LiteLLMExtensionState = {};

export default async function actsisLiteLLMExtension(pi: ExtensionAPI) {
  // Register commands first; they work independently of provider registration.
  const commandDeps = defaultCommandDeps();
  commandDeps.getState = () => state;

  pi.registerCommand("litellm:status", {
    description: "Show LiteLLM gateway status and model cache state",
    handler: buildStatusHandler(commandDeps),
  });

  pi.registerCommand("litellm:models", {
    description: "Force-sync LiteLLM model catalog and show changes",
    handler: buildModelsCommandHandler(commandDeps),
  });

  pi.registerCommand("litellm:logout", {
    description: "Revoke LiteLLM credentials and clear local state",
    handler: buildLogoutHandler(commandDeps),
  });

  pi.on("message_end", async (event, ctx) => {
    const rewritten = normalizeOverflowError(
      state.providerId,
      event.message as {
        role: string;
        stopReason?: string;
        errorMessage?: string;
        provider?: string;
      },
      ctx?.model?.provider,
    );
    if (rewritten) {
      return { message: rewritten as never };
    }
    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify("pi-actsis-litellm loaded", "info");
    }
  });

  // Attempt quiet config resolution. If the gateway URL is not configured
  // yet, skip provider registration; the user can still use /login.
  try {
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
      prompt: async () => undefined,
    });

    const providerConfig = await buildProviderConfig(cfg);
    pi.registerProvider(cfg.providerId, providerConfig);
    state.providerId = cfg.providerId;
    state.catalogCount = providerConfig.models.length;
  } catch (err) {
    if (err instanceof ConfigError) {
      pi.on("session_start", async (_event, ctx) => {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "pi-actsis-litellm: gateway URL not configured; /login will prompt",
            "info",
          );
        }
      });
      return;
    }
    throw err;
  }
}
