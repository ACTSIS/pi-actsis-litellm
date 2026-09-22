import { DiscoveryError, AuthError, CatalogError } from "./errors.ts";

export interface CliAuthDiscovery {
  contractVersion: number;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string;
  resource: string;
  codeChallengeMethods: string[];
  grantTypes: string[];
  tokenEndpointAuthMethods: string[];
}

function getOrigin(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`.toLowerCase();
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "").toLowerCase();
}

function parseHttpUrl(value: unknown, name: string): URL {
  if (typeof value !== "string") {
    throw new DiscoveryError(`${name} must be a string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DiscoveryError(`${name} is not a valid URL: ${value}`);
  }
  if (!url.protocol.startsWith("http")) {
    throw new DiscoveryError(
      `${name} must use http:// or https://: ${value}`,
    );
  }
  return url;
}

interface SameOriginResult {
  value: string;
  upgraded: boolean;
}

function requireSameOrigin(
  baseOrigin: string,
  value: unknown,
  name: string,
): SameOriginResult {
  const url = parseHttpUrl(value, name);
  const endpointOrigin = getOrigin(value as string);

  if (endpointOrigin === baseOrigin) {
    return { value: value as string, upgraded: false };
  }

  // Scheme-tolerant same-origin check: allow an automatic http -> https
  // upgrade when the caller's base URL is https and the announced endpoint
  // is http, as long as host and port are identical. Never downgrade.
  const baseParsed = new URL(baseOrigin);
  if (
    url.host.toLowerCase() !== baseParsed.host.toLowerCase() ||
    url.protocol.toLowerCase() !== "http:" ||
    baseParsed.protocol.toLowerCase() !== "https:"
  ) {
    throw new DiscoveryError(
      `${name} must be same-origin with the gateway (${baseOrigin}), got ${endpointOrigin}`,
    );
  }

  const upgraded = (value as string).replace(/^http:/i, "https:");
  return { value: upgraded, upgraded: true };
}

export type DiscoveryAdaptation =
  | { kind: "scheme-upgraded"; announcedIssuer: string; effectiveIssuer: string }
  | null;

export function validateDiscoveryWithAdaptation(
  raw: unknown,
  baseUrl: string,
): { discovery: CliAuthDiscovery; adaptation: DiscoveryAdaptation } {
  if (typeof raw !== "object" || raw === null) {
    throw new DiscoveryError("Discovery response is not an object");
  }

  const record = raw as Record<string, unknown>;

  if (record.contract_version !== 1) {
    throw new DiscoveryError(
      `Unsupported CLI auth contract version: ${String(record.contract_version)}`,
    );
  }

  const expectedOrigin = normalizeOrigin(getOrigin(baseUrl));

  if (typeof record.issuer !== "string" || !record.issuer.startsWith("http")) {
    throw new DiscoveryError(
      `Discovery issuer is missing or not an HTTP URL: ${String(record.issuer)}`,
    );
  }
  const issuerOrigin = getOrigin(record.issuer);
  let issuer = record.issuer;
  let adaptation: DiscoveryAdaptation = null;

  if (issuerOrigin !== expectedOrigin) {
    const issuerParsed = parseHttpUrl(record.issuer, "issuer");
    const baseParsed = new URL(expectedOrigin);
    const sameHost =
      issuerParsed.host.toLowerCase() === baseParsed.host.toLowerCase();
    const allowedDirection =
      issuerParsed.protocol.toLowerCase() === "http:" &&
      baseParsed.protocol.toLowerCase() === "https:";

    if (!sameHost || !allowedDirection) {
      throw new DiscoveryError(
        `Discovery issuer origin mismatch: expected ${expectedOrigin}, got ${issuerOrigin}`,
      );
    }

    const upgradedIssuer = record.issuer.replace(/^http:/i, "https:");
    adaptation = {
      kind: "scheme-upgraded",
      announcedIssuer: record.issuer,
      effectiveIssuer: upgradedIssuer,
    };
    issuer = upgradedIssuer;
  }

  const authorizationEndpoint = requireSameOrigin(
    expectedOrigin,
    record.authorization_endpoint,
    "authorization_endpoint",
  );
  const tokenEndpoint = requireSameOrigin(
    expectedOrigin,
    record.token_endpoint,
    "token_endpoint",
  );
  const registrationEndpoint = requireSameOrigin(
    expectedOrigin,
    record.registration_endpoint,
    "registration_endpoint",
  );
  const revocationEndpoint = requireSameOrigin(
    expectedOrigin,
    record.revocation_endpoint,
    "revocation_endpoint",
  );

  // resource must be accepted if it is same-origin with either the announced
  // origin or the upgraded origin, but it is always preserved verbatim because
  // the gateway expects the exact announced resource value in authorize/token
  // bodies.
  const resourceUrl = parseHttpUrl(record.resource, "resource");
  const resourceOrigin = getOrigin(record.resource as string);
  const resourceMatchesAnnounced = resourceOrigin === issuerOrigin;
  const resourceMatchesEffective = resourceOrigin === expectedOrigin;
  if (!resourceMatchesAnnounced && !resourceMatchesEffective) {
    requireSameOrigin(expectedOrigin, record.resource, "resource");
  }
  const resource = record.resource as string;

  const codeChallengeMethods = Array.isArray(record.code_challenge_methods_supported)
    ? record.code_challenge_methods_supported.map((m) => String(m))
    : [];
  if (!codeChallengeMethods.includes("S256")) {
    throw new DiscoveryError(
      "Discovery does not advertise PKCE S256 code challenge method",
    );
  }

  const grantTypes = Array.isArray(record.grant_types_supported)
    ? record.grant_types_supported.map((g) => String(g))
    : [];
  if (!grantTypes.includes("authorization_code")) {
    throw new DiscoveryError(
      "Discovery does not advertise authorization_code grant type",
    );
  }
  if (!grantTypes.includes("refresh_token")) {
    throw new DiscoveryError(
      "Discovery does not advertise refresh_token grant type",
    );
  }

  const tokenEndpointAuthMethods = Array.isArray(
    record.token_endpoint_auth_methods_supported,
  )
    ? record.token_endpoint_auth_methods_supported.map((m) => String(m))
    : [];

  return {
    discovery: {
      contractVersion: 1,
      issuer,
      authorizationEndpoint: authorizationEndpoint.value,
      tokenEndpoint: tokenEndpoint.value,
      registrationEndpoint: registrationEndpoint.value,
      revocationEndpoint: revocationEndpoint.value,
      resource,
      codeChallengeMethods,
      grantTypes,
      tokenEndpointAuthMethods,
    },
    adaptation,
  };
}

export function validateDiscovery(
  raw: unknown,
  baseUrl: string,
): CliAuthDiscovery {
  return validateDiscoveryWithAdaptation(raw, baseUrl).discovery;
}

function discoveryUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return `${normalized}/.well-known/litellm-cli-auth`;
}

export async function fetchCliAuthDiscovery(
  baseUrl: string,
  timeoutMs: number,
  onAdaptation?: (a: NonNullable<DiscoveryAdaptation>) => void,
): Promise<CliAuthDiscovery> {
  let response: Response;
  try {
    response = await fetch(discoveryUrl(baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new DiscoveryError(
      `Failed to fetch CLI auth discovery: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!response.ok) {
    throw new DiscoveryError(
      `Discovery endpoint returned ${response.status}: ${response.statusText}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new DiscoveryError(
      `Discovery response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const { discovery, adaptation } = validateDiscoveryWithAdaptation(body, baseUrl);
  if (adaptation) {
    onAdaptation?.(adaptation);
  }
  return discovery;
}

interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
}

function extractErrorDescription(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const error = (body as Record<string, unknown>).error;
  const description = (body as Record<string, unknown>).error_description;
  const parts: string[] = [];
  if (typeof error === "string" && error) parts.push(error);
  if (typeof description === "string" && description) parts.push(description);
  return parts.join(" — ");
}

export async function registerClient(
  discovery: CliAuthDiscovery,
  redirectUri: string,
  timeoutMs: number,
): Promise<RegisteredClient> {
  const response = await fetch(discovery.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "pi-actsis-litellm",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location") ?? "unknown";
    throw new AuthError(
      `Client registration redirected unexpectedly to ${location}. Refusing to send credentials to another origin.`,
    );
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const description = extractErrorDescription(body) ||
      `${response.status}: ${response.statusText}`;
    throw new AuthError(`Client registration failed: ${description}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new AuthError(
      `Client registration response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (typeof body !== "object" || body === null) {
    throw new AuthError("Client registration response is not an object");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.client_id !== "string" || !record.client_id) {
    throw new AuthError(
      "Client registration response missing client_id",
    );
  }

  return {
    clientId: record.client_id,
    redirectUris: Array.isArray(record.redirect_uris)
      ? record.redirect_uris.map((u) => String(u))
      : [redirectUri],
  };
}

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken: string | null;
  userId?: string;
  teamId?: string;
}

interface ExchangeAuthorizationCodeInput {
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
}

export async function exchangeAuthorizationCode(
  discovery: CliAuthDiscovery,
  input: ExchangeAuthorizationCodeInput,
  timeoutMs: number,
): Promise<TokenResponse> {
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("code", input.code);
  params.set("redirect_uri", input.redirectUri);
  params.set("client_id", input.clientId);
  params.set("code_verifier", input.codeVerifier);
  params.set("resource", discovery.resource);

  const response = await fetch(discovery.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location") ?? "unknown";
    throw new AuthError(
      `Token endpoint redirected unexpectedly to ${location}. Refusing to replay authorization code to another origin.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new AuthError(
      `Token response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!response.ok) {
    const description = extractErrorDescription(body) ||
      `${response.status}: ${response.statusText}`;
    throw new AuthError(`Authorization code exchange failed: ${description}`);
  }

  if (typeof body !== "object" || body === null) {
    throw new AuthError("Token response is not an object");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.access_token !== "string" || !record.access_token) {
    throw new AuthError("Token response missing access_token");
  }

  return {
    accessToken: record.access_token,
    tokenType: typeof record.token_type === "string"
      ? record.token_type
      : "Bearer",
    expiresIn: typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
      ? record.expires_in
      : 3600,
    refreshToken: typeof record.refresh_token === "string" && record.refresh_token
      ? record.refresh_token
      : null,
    userId: typeof record.user_id === "string" && record.user_id
      ? record.user_id
      : undefined,
    teamId: typeof record.team_id === "string" && record.team_id
      ? record.team_id
      : undefined,
  };
}

interface RefreshGrantInput {
  refreshToken: string;
  clientId: string;
}

export async function refreshGrant(
  discovery: CliAuthDiscovery,
  input: RefreshGrantInput,
  timeoutMs: number,
): Promise<TokenResponse> {
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", input.refreshToken);
  params.set("client_id", input.clientId);
  params.set("resource", discovery.resource);

  const response = await fetch(discovery.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location") ?? "unknown";
    throw new AuthError(
      `Token refresh redirected unexpectedly to ${location}. Refusing to replay refresh token to another origin.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new AuthError(
      `Refresh response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!response.ok) {
    if (
      response.status === 400 &&
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>).error === "invalid_grant"
    ) {
      throw new AuthError(
        "Refresh token was refused, rotated, or revoked. Run /login again.",
      );
    }
    const description = extractErrorDescription(body) ||
      `${response.status}: ${response.statusText}`;
    throw new AuthError(`Token refresh failed: ${description}`);
  }

  if (typeof body !== "object" || body === null) {
    throw new AuthError("Refresh response is not an object");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.access_token !== "string" || !record.access_token) {
    throw new AuthError("Refresh response missing access_token");
  }

  return {
    accessToken: record.access_token,
    tokenType: typeof record.token_type === "string" ? record.token_type : "Bearer",
    expiresIn: typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
      ? record.expires_in
      : 3600,
    refreshToken: typeof record.refresh_token === "string" && record.refresh_token
      ? record.refresh_token
      : null,
    userId: typeof record.user_id === "string" && record.user_id
      ? record.user_id
      : undefined,
    teamId: typeof record.team_id === "string" && record.team_id
      ? record.team_id
      : undefined,
  };
}

interface RevokeTokenInput {
  token: string;
  clientId: string;
}

export async function revokeToken(
  discovery: CliAuthDiscovery,
  input: RevokeTokenInput,
  timeoutMs: number,
): Promise<boolean> {
  const params = new URLSearchParams();
  params.set("token", input.token);
  params.set("client_id", input.clientId);

  const response = await fetch(discovery.revocationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location") ?? "unknown";
    throw new AuthError(
      `Revocation endpoint redirected unexpectedly to ${location}. Refusing to send token to another origin.`,
    );
  }

  if (response.ok) {
    return true;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const description = extractErrorDescription(body) ||
    `${response.status}: ${response.statusText}`;
  throw new AuthError(`Token revocation failed: ${description}`);
}

export interface ModelsResponse {
  baseUrl: string;
  body: unknown;
}

export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<ModelsResponse> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${normalized}/v1/models?include_metadata=true`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(
      "Credential rejected by gateway. Run /login again.",
    );
  }

  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch models: ${response.status}: ${response.statusText}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new CatalogError(
      `Models response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return { baseUrl: normalized, body };
}

export async function fetchModelInfo(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<ModelsResponse> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${normalized}/model/info`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(
      "Credential rejected by gateway. Run /login again.",
    );
  }

  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch model info: ${response.status}: ${response.statusText}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new CatalogError(
      `Model info response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return { baseUrl: normalized, body };
}

export async function fetchModelInfoV2(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  page: number,
  size: number,
): Promise<ModelsResponse> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("size", String(size));
  params.set("page", String(page));
  const response = await fetch(`${normalized}/v2/model/info?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(
      "Credential rejected by gateway. Run /login again.",
    );
  }

  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch model info (v2 page ${page}): ${response.status}: ${response.statusText}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new CatalogError(
      `Model info (v2 page ${page}) response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return { baseUrl: normalized, body };
}
