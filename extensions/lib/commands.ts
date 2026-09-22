import os from "node:os";
import path from "node:path";
import { readFile, writeFile, rm, access } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, AuthResult, Model } from "@earendil-works/pi-ai";
import type { OAuthCredential } from "@earendil-works/pi-ai/compat";
import { resolveConfig, type ActsisEnabledConfig } from "./config.ts";
import { ConfigError } from "./errors.ts";
import { revokeToken, type CliAuthDiscovery } from "./client.ts";
import { storedToDiscovery } from "./provider.ts";
import { loadCachedModels, computeCacheAge } from "./catalog.ts";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { LiteLLMExtensionState } from "../index.ts";

const DEFAULT_PROVIDER_ID = "actsis-litellm";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface CommandDeps {
  getState: () => LiteLLMExtensionState;
  cachePath: string;
  authPath: string;
  requestTimeoutMs: number;
}

export function defaultCommandDeps(): CommandDeps {
  return {
    getState: () => ({}),
    cachePath: path.join(
      os.homedir(),
      ".pi",
      "agent",
      "actsis-litellm-models-cache.json",
    ),
    authPath: path.join(os.homedir(), ".pi", "agent", "auth.json"),
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

function getProviderId(deps: CommandDeps): string {
  return deps.getState().providerId?.trim() || DEFAULT_PROVIDER_ID;
}

async function resolveNonInteractiveConfig(): Promise<ActsisEnabledConfig | null> {
  try {
    return await resolveConfig({
      env: process.env,
      fileLoader: async (filePath) => {
        try {
          const { readFile } = await import("node:fs/promises");
          const raw = await readFile(filePath, "utf8");
          return JSON.parse(raw);
        } catch {
          return null;
        }
      },
      prompt: async () => undefined,
    });
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}

function providerModels(
  registryModels: Model<Api>[],
  providerId: string,
): Model<Api>[] {
  return registryModels.filter((m) => m.provider === providerId);
}

function formatCacheAge(ageMs: number | null): string {
  if (ageMs === null) return "none";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes <= 0) return "just now";
  return `${minutes}m ago`;
}

function formatExpiry(credential: OAuthCredential | undefined): string {
  if (!credential) return "never";
  const expires =
    typeof credential.expires === "number" ? credential.expires : null;
  if (expires === null || !Number.isFinite(expires)) return "never";
  try {
    return new Date(expires).toISOString();
  } catch {
    return "never";
  }
}

function extractOAuthCredential(result: AuthResult | undefined): OAuthCredential | undefined {
  if (!result) return undefined;
  const credential = (result as AuthResult & { credential?: unknown }).credential;
  if (
    credential &&
    typeof credential === "object" &&
    (credential as Record<string, unknown>).type === "oauth"
  ) {
    return credential as OAuthCredential;
  }
  return undefined;
}

function discoveryFromCredential(credential: OAuthCredential): CliAuthDiscovery | undefined {
  const tokenEndpoint =
    typeof credential.tokenEndpoint === "string" ? credential.tokenEndpoint : "";
  const revocationEndpoint =
    typeof credential.revocationEndpoint === "string"
      ? credential.revocationEndpoint
      : "";
  const resource =
    typeof credential.resource === "string" ? credential.resource : "";

  if (!tokenEndpoint || !revocationEndpoint || !resource) {
    return undefined;
  }

  return storedToDiscovery(credential);
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "error" | "warning" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

export function buildStatusHandler(deps: CommandDeps) {
  return async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const providerId = getProviderId(deps);

    try {
      const cfg = await resolveNonInteractiveConfig();
      if (!cfg) {
        notify(
          ctx,
          "Gateway URL not configured. Set ACTSIS_LITELLM_URL or use /login to configure.",
          "warning",
        );
        return;
      }

      const registered = ctx.modelRegistry
        .getRegisteredProviderIds()
        .includes(providerId);
      const authStatus = ctx.modelRegistry.getProviderAuthStatus(providerId);

      const authResult = await ctx.modelRegistry.getProviderAuth(providerId);
      const oauthCredential = extractOAuthCredential(authResult);

      let authLine: string;
      let sourceLine = "Credential source: unknown";

      if (oauthCredential) {
        const expiry = formatExpiry(oauthCredential);
        authLine = `Auth: oauth credential stored (expires ${expiry})`;
        const source = (authResult as AuthResult & { source?: string }).source;
        if (typeof source === "string" && source) {
          sourceLine = `Credential source: ${source}`;
        } else {
          sourceLine = "Credential source: stored";
        }
      } else if (authResult) {
        authLine = "Auth: credential stored";
        const source = (authResult as AuthResult & { source?: string }).source;
        if (typeof source === "string" && source) {
          sourceLine = `Credential source: ${source}`;
        }
      } else {
        authLine = "Auth: no credential";
      }

      const count = providerModels(ctx.modelRegistry.getAll(), providerId).length;
      const age = await computeCacheAge(deps.cachePath);

      const text = [
        `Provider: ${providerId} — ${registered ? "registered" : "not registered"}`,
        authLine,
        sourceLine,
        `Catalog: ${count} models for provider, cache age: ${formatCacheAge(age)}`,
        `Gateway: ${cfg.baseUrl}`,
      ].join("\n");
      notify(ctx, text, "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(ctx, `litellm:status failed: ${message}`, "error");
    }
  };
}

export function buildModelsCommandHandler(deps: CommandDeps) {
  return async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const providerId = getProviderId(deps);

    if (ctx.hasUI) {
      ctx.ui.notify("Syncing model catalog from gateway...", "info");
    }

    try {
      const previous = await loadCachedModels(deps.cachePath);
      const previousIds = new Set(
        (previous ?? []).map((m: ProviderModelConfig) => m.id),
      );

      await ctx.modelRegistry.refresh({
        allowNetwork: true,
        providers: [providerId],
        force: true,
      });

      const current = providerModels(ctx.modelRegistry.getAll(), providerId);
      const currentIds = current.map((m) => m.id);
      const count = current.length;

      let message = `Model catalog synced: ${count} models available.`;

      if (previous !== null) {
        const added = currentIds.filter((id) => !previousIds.has(id)).length;
        const removed = previous.filter((m) => !currentIds.includes(m.id)).length;
        if (added > 0 || removed > 0) {
          message += ` (added ${added}, removed ${removed})`;
        }
      }

      notify(ctx, message, "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(ctx, `litellm:models failed: ${message}`, "error");
    }
  };
}

async function clearAuthJson(authPath: string, providerId: string): Promise<void> {
  try {
    await access(authPath);
  } catch {
    return;
  }

  let parsed: unknown;
  try {
    const raw = await readFile(authPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  if (typeof parsed !== "object" || parsed === null) return;
  const record = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, providerId)) return;

  delete record[providerId];

  await writeFile(authPath, JSON.stringify(record, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function clearCache(cachePath: string): Promise<void> {
  try {
    await rm(cachePath, { force: true });
  } catch {
    // Best-effort; ignore cleanup failures.
  }
}

export function buildLogoutHandler(deps: CommandDeps) {
  return async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const providerId = getProviderId(deps);

    try {
      const authResult = await ctx.modelRegistry.getProviderAuth(providerId);
      const credential = extractOAuthCredential(authResult);

      if (!credential) {
        notify(ctx, `No stored credentials for ${providerId}.`, "warning");
        return;
      }

      const refresh =
        typeof credential.refresh === "string" ? credential.refresh : "";
      const clientId =
        typeof credential.clientId === "string" ? credential.clientId : "";
      const discovery = discoveryFromCredential(credential);

      if (refresh && discovery) {
        try {
          await revokeToken(
            discovery,
            { token: refresh, clientId },
            deps.requestTimeoutMs,
          );
        } catch (err) {
          if (err instanceof Error && err.message.includes("fetch")) {
            notify(
              ctx,
              "Could not reach gateway to revoke the refresh token (it will still expire on its own).",
              "warning",
            );
          }
          // Continue clearing local state even if revocation fails.
        }
      }

      await clearAuthJson(deps.authPath, providerId);
      await clearCache(deps.cachePath);

      notify(
        ctx,
        "Logged out. Refresh token revoked on gateway (or expired locally). Catalog cache cleared.",
        "info",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(ctx, `litellm:logout failed: ${message}`, "error");
    }
  };
}
