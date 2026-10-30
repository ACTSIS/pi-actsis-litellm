import { ConfigError } from "./errors.ts";
import os from "node:os";
import path from "node:path";

export interface ActsisEnabledConfig {
  baseUrl: string;
  providerId: string;
  catalogTtlMs: number;
  requestTimeoutMs: number;
}

export interface ConfigFileShape {
  baseUrl?: string;
  providerId?: string;
  catalogTtlMinutes?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_PROVIDER_ID = "actsis-litellm";
const DEFAULT_CATALOG_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(
      `Invalid gateway URL: ${raw}. It must be an http:// or https:// URL.`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(
      `Invalid gateway URL: ${raw}. Only http:// and https:// are supported.`,
    );
  }

  let normalized = `${url.protocol}//${url.host}${url.pathname}`;
  normalized = normalized.replace(/\/+$/, "");
  normalized = normalized.replace(/\/v1$/, "");
  return normalized;
}

function normalizeProviderId(raw: string | undefined): string {
  const id = raw?.trim();
  if (!id) return DEFAULT_PROVIDER_ID;
  return id;
}

function normalizeCatalogTtlMs(raw: number | undefined): number {
  if (raw === undefined || raw === null) return DEFAULT_CATALOG_TTL_MS;
  const ms = raw * 60 * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_CATALOG_TTL_MS;
  return ms;
}

function normalizeRequestTimeoutMs(raw: number | undefined): number {
  if (raw === undefined || raw === null) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_REQUEST_TIMEOUT_MS;
  return raw;
}

export interface ConfigResolutionDeps {
  env: Record<string, string | undefined>;
  fileLoader: (path: string) => Promise<ConfigFileShape | null>;
  prompt: () => Promise<string | null | undefined>;
  storedUrl?: string | null;
  /** Explicit home directory; tests inject it. Defaults to HOME, then os.homedir(). */
  homeDir?: string;
}

/**
 * Root of the per-user config files. Must agree with auth.json and the model
 * cache, which are both read from os.homedir(): on Windows (PowerShell) HOME is
 * undefined, so a HOME-only path silently pointed at "/.pi/..." instead of the
 * user profile (issue #59 S2).
 */
function resolveHomeDir(deps: ConfigResolutionDeps): string {
  const injected = deps.homeDir?.trim();
  if (injected) return injected;
  const envHome = deps.env.HOME?.trim();
  if (envHome) return envHome;
  return os.homedir();
}

export async function resolveConfig(
  deps: ConfigResolutionDeps,
): Promise<ActsisEnabledConfig> {
  const envUrl = deps.env.ACTSIS_LITELLM_URL?.trim();
  const filePaths = [
    path.join(resolveHomeDir(deps), ".pi", "agent", "actsis-litellm.json"),
    `./.pi/actsis-litellm.user.json`,
  ];

  let fileValue: ConfigFileShape | null = null;
  for (const path of filePaths) {
    fileValue = await deps.fileLoader(path);
    if (fileValue) break;
  }

  let rawUrl = envUrl || fileValue?.baseUrl?.trim();

  if (!rawUrl) {
    rawUrl = deps.storedUrl?.trim();
  }

  if (!rawUrl) {
    const prompted = await deps.prompt();
    rawUrl = prompted?.trim();
  }

  if (!rawUrl) {
    throw new ConfigError(
      "Gateway base URL not configured. Set ACTSIS_LITELLM_URL, add it to ~/.pi/agent/actsis-litellm.json or ./.pi/actsis-litellm.user.json, or provide it during login.",
    );
  }

  const baseUrl = normalizeBaseUrl(rawUrl);

  return {
    baseUrl,
    providerId: normalizeProviderId(fileValue?.providerId),
    catalogTtlMs: normalizeCatalogTtlMs(fileValue?.catalogTtlMinutes),
    requestTimeoutMs: normalizeRequestTimeoutMs(fileValue?.requestTimeoutMs),
  };
}
