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
    const origin = `${url.protocol}//${url.host}`;
    return upgradeHttpToHttps(origin);
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
    return { url: normalizeBaseUrl(parts.env), source: "env" };
  }
  if (parts.file) {
    return { url: normalizeBaseUrl(parts.file), source: "config-file" };
  }
  if (parts.stored) {
    return { url: normalizeBaseUrl(parts.stored), source: "stored-credential" };
  }
  return null;
}

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
