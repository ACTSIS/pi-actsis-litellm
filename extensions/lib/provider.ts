import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai/compat";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  resolveConfig,
  type ActsisEnabledConfig,
  type ConfigFileShape,
  type ConfigResolutionDeps,
} from "./config.ts";
import { fetchCliAuthDiscovery, refreshGrant, type CliAuthDiscovery } from "./client.ts";
import { runLoginFlow } from "./oauth.ts";
import { AuthError, ConfigError } from "./errors.ts";
import {
  fetchCatalogModels,
  loadCachedModels,
  saveCachedModels,
  computeCacheAge,
} from "./catalog.ts";

export const CACHE_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "actsis-litellm-models-cache.json",
);

interface ProviderBuildDeps {
  loadCachedModels: (cachePath: string) => Promise<ProviderModelConfig[] | null>;
  saveCachedModels: (
    cachePath: string,
    models: ProviderModelConfig[],
  ) => Promise<void>;
  computeCacheAge: (cachePath: string) => Promise<number | null>;
}

export interface BuiltProviderConfig {
  name: string;
  baseUrl: string;
  api: "openai-completions";
  models: ProviderModelConfig[];
  oauth: {
    name: string;
    login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;
    refreshToken: (
      credentials: OAuthCredentials,
      signal: AbortSignal,
    ) => Promise<OAuthCredentials>;
    getApiKey: (credentials: OAuthCredentials) => string;
  };
  refreshModels: (context: RefreshModelsContext) => Promise<ProviderModelConfig[]>;
}

function storedToDiscovery(credentials: OAuthCredentials): CliAuthDiscovery {
  const tokenEndpoint =
    typeof credentials.tokenEndpoint === "string" ? credentials.tokenEndpoint : "";
  const revocationEndpoint =
    typeof credentials.revocationEndpoint === "string"
      ? credentials.revocationEndpoint
      : "";
  const resource =
    typeof credentials.resource === "string" ? credentials.resource : "";

  // For refresh we only need tokenEndpoint + resource; the remaining fields are
  // preserved as placeholders so the rest of the contract stays intact.
  return {
    contractVersion: 1,
    issuer: tokenEndpoint ? new URL(tokenEndpoint).origin : "",
    authorizationEndpoint: tokenEndpoint,
    tokenEndpoint,
    registrationEndpoint: tokenEndpoint,
    revocationEndpoint,
    resource,
    codeChallengeMethods: ["S256"],
    grantTypes: ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethods: ["none"],
  };
}

function createFileLoader(): ConfigResolutionDeps["fileLoader"] {
  return async (filePath: string): Promise<ConfigFileShape | null> => {
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as ConfigFileShape;
    } catch {
      return null;
    }
  };
}

async function resolveNonInteractiveConfig(): Promise<ActsisEnabledConfig | null> {
  try {
    return await resolveConfig({
      env: process.env,
      fileLoader: createFileLoader(),
      prompt: async () => undefined,
    });
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}

export async function buildProviderConfig(
  cfg: ActsisEnabledConfig,
  deps?: Partial<ProviderBuildDeps>,
): Promise<BuiltProviderConfig> {
  const loadCache = deps?.loadCachedModels ?? loadCachedModels;
  const saveCache = deps?.saveCachedModels ?? saveCachedModels;
  const cacheAge = deps?.computeCacheAge ?? computeCacheAge;

  const cached = await loadCache(CACHE_PATH);
  const initialModels = cached ?? [];

  const oauth = {
    name: "LiteLLM Gateway (SSO)",
    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const config = await resolveConfig({
        env: process.env,
        fileLoader: createFileLoader(),
        prompt: async () =>
          callbacks.onPrompt({
            message:
              "Gateway base URL (e.g. https://gateway.example.com)",
          }),
      });
      const discovery = await fetchCliAuthDiscovery(
        config.baseUrl,
        config.requestTimeoutMs,
      );
      return runLoginFlow(config, discovery, callbacks);
    },
    async refreshToken(
      credentials: OAuthCredentials,
      signal: AbortSignal,
    ): Promise<OAuthCredentials> {
      const refreshToken =
        typeof credentials.refresh === "string" ? credentials.refresh : "";
      const clientId =
        typeof credentials.clientId === "string" ? credentials.clientId : "";
      if (!refreshToken) {
        throw new AuthError("No refresh token stored; run /login again.");
      }

      const discovery = storedToDiscovery(credentials);
      const refreshed = await refreshGrant(
        discovery,
        { refreshToken, clientId },
        cfg.requestTimeoutMs,
      );

      const expires =
        Date.now() + Math.max(refreshed.expiresIn - 300, 60) * 1000;

      return {
        ...credentials,
        access: refreshed.accessToken,
        refresh: refreshed.refreshToken ?? credentials.refresh,
        expires,
        userId: refreshed.userId ?? credentials.userId,
        teamId: refreshed.teamId ?? credentials.teamId,
      };
    },
    getApiKey(credentials: OAuthCredentials): string {
      return typeof credentials.access === "string" ? credentials.access : "";
    },
  };

  async function refreshModels(
    context: RefreshModelsContext,
  ): Promise<ProviderModelConfig[]> {
    const stored = context.stored;
    const storedModels: ProviderModelConfig[] = Array.isArray(stored?.models)
      ? (stored.models as ProviderModelConfig[])
      : [];

    if (!context.allowNetwork) {
      return storedModels;
    }

    const credential = context.credential;
    const apiKey =
      credential?.type === "oauth" &&
      typeof (credential as unknown as OAuthCredentials).access === "string"
        ? (credential as unknown as OAuthCredentials).access
        : undefined;

    if (!apiKey) {
      return storedModels;
    }

    const age = await cacheAge(CACHE_PATH);
    const hasFreshCache =
      age !== null && age < cfg.catalogTtlMs && storedModels.length > 0;
    if (!context.force && hasFreshCache) {
      return storedModels;
    }

    let freshModels: ProviderModelConfig[];
    try {
      freshModels = await fetchCatalogModels(cfg, apiKey, context.signal);
    } catch (err) {
      return storedModels;
    }

    await saveCache(CACHE_PATH, freshModels);

    // Publish the updated catalog to Pi's persistent models store.
    await context.publish({
      persist: {
        models: freshModels as unknown as import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>[],
        checkedAt: Date.now(),
      },
    });

    return freshModels;
  }

  return {
    name: "LiteLLM Gateway",
    baseUrl: `${cfg.baseUrl}/v1`,
    api: "openai-completions",
    models: initialModels,
    oauth,
    refreshModels,
  };
}
