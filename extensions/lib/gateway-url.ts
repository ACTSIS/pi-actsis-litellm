import { normalizeBaseUrl } from "./config.ts";

export interface GatewayUrlSource {
  url: string;
  source: "env" | "config-file" | "stored-credential";
}

export interface AuthJsonEntry {
  tokenEndpoint?: string;
  [key: string]: unknown;
}

export type AuthJsonLoader = (authPath: string) => Promise<unknown>;

export async function readStoredCredentialGatewayUrl(
  authPath: string,
  providerId: string,
  loader: AuthJsonLoader = defaultAuthJsonLoader,
): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = await loader(authPath);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const entry = record[providerId];
  if (typeof entry !== "object" || entry === null) {
    return null;
  }

  const tokenEndpoint = (entry as AuthJsonEntry).tokenEndpoint;
  if (typeof tokenEndpoint !== "string" || !tokenEndpoint) {
    return null;
  }

  try {
    const url = new URL(tokenEndpoint);
    // The credential preserves the gateway URL exactly as the user defined it
    // at login (including its scheme). A LAN gateway served over plain http
    // (for example http://192.0.2.10, an RFC 5737 documentation address) has no
    // TLS, so forcing https here breaks every runtime call. Scheme adaptation
    // stays only in discovery validation.
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export function pickGatewayUrl(parts: {
  env?: string | undefined;
  file?: string | undefined;
  stored?: string | undefined;
}): GatewayUrlSource | null {
  if (parts.env) {
    try {
      return { url: normalizeBaseUrl(parts.env), source: "env" };
    } catch {
      // Env value is invalid; treat it as absent and fall through.
    }
  }
  if (parts.file) {
    try {
      return { url: normalizeBaseUrl(parts.file), source: "config-file" };
    } catch {
      // File value is invalid; treat it as absent and fall through.
    }
  }
  if (parts.stored) {
    try {
      return {
        url: normalizeBaseUrl(parts.stored),
        source: "stored-credential",
      };
    } catch {
      // Stored value is invalid; treat it as absent.
    }
  }
  return null;
}

/**
 * Kept for compatibility with the discovery-time scheme adaptation helpers;
 * the stored-credential URL reader no longer upgrades schemes.
 */
export function upgradeHttpToHttps(origin: string): string {
  const url = new URL(origin);
  if (url.protocol.toLowerCase() === "http:") {
    return origin.replace(/^http:/i, "https:");
  }
  return origin;
}

async function defaultAuthJsonLoader(authPath: string): Promise<unknown> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(authPath, "utf8");
  return JSON.parse(raw);
}
