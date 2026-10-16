import { ConfigError } from "./errors.ts";
import { loadRoleProfiles } from "./role-profiles.ts";

export interface ActsisEnabledConfig {
  baseUrl: string;
  providerId: string;
  catalogTtlMs: number;
  requestTimeoutMs: number;
  /** Model-routing role (docs/model-routing-policy.md in actsis-dots). */
  role?: string;
  /** Path to the role-profiles file (same contract as llm-server's role-profiles.json). */
  roleProfilesPath?: string;
}

export interface ConfigFileShape {
  baseUrl?: string;
  providerId?: string;
  catalogTtlMinutes?: number;
  requestTimeoutMs?: number;
  role?: string;
  roleProfilesPath?: string;
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
}

export async function resolveConfig(
  deps: ConfigResolutionDeps,
): Promise<ActsisEnabledConfig> {
  const envUrl = deps.env.ACTSIS_LITELLM_URL?.trim();
  const filePaths = [
    `${deps.env.HOME ?? ""}/.pi/agent/actsis-litellm.json`,
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

  // Model-routing role resolution (env overrides the config-file field). When
  // a role is configured, resolution validates it against the profiles file
  // and fails closed on anything unusable; with no role, nothing extra runs.
  const envRole = deps.env.ACTSIS_LITELLM_ROLE?.trim() || undefined;
  const fileRole = fileValue?.role?.trim() || undefined;
  const role = envRole ?? fileRole;
  const roleProfilesPath = fileValue?.roleProfilesPath?.trim() || undefined;
  if (role) {
    if (!roleProfilesPath) {
      throw new ConfigError(
        `Role "${role}" is configured but roleProfilesPath is missing: set roleProfilesPath in the config file to the role-profiles.json produced by llm-server provisioning.`,
      );
    }
    const rawProfiles = await deps.fileLoader(roleProfilesPath);
    if (rawProfiles === null) {
      throw new ConfigError(
        `Role "${role}": role profiles unreadable at ${roleProfilesPath} (set roleProfilesPath to a readable role-profiles.json produced by llm-server provisioning).`,
      );
    }
    let profiles;
    try {
      profiles = loadRoleProfiles(rawProfiles as unknown);
    } catch (err) {
      throw new ConfigError(
        `Role "${role}": ${err instanceof Error ? err.message.slice("roleProfiles: ".length) : String(err)}`,
      );
    }
    if (!profiles.roles[role]) {
      throw new ConfigError(
        `unknown role "${role}" (available: ${Object.keys(profiles.roles).sort().join(", ")})`,
      );
    }
  }

  return {
    baseUrl,
    providerId: normalizeProviderId(fileValue?.providerId),
    catalogTtlMs: normalizeCatalogTtlMs(fileValue?.catalogTtlMinutes),
    requestTimeoutMs: normalizeRequestTimeoutMs(fileValue?.requestTimeoutMs),
    ...(role ? { role } : {}),
    ...(role ? { roleProfilesPath } : {}),
  };
}
