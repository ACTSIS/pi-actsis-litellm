import { AuthError, CatalogError } from "./errors.ts";
import { fetchFailureMessage } from "./network-error.ts";

/**
 * Gateway identity for /actsis-litellm:status (specs S1–S5 of
 * odd/tasks/status-identity.md). Only the allowlisted fields of /user/info
 * ever enter this module's output: the raw gateway body (including
 * `keys[].token` in clear text) is reduced in memory and never persisted or
 * printed (S5).
 */
export interface GatewayIdentity {
  userId: string | null;
  userEmail: string | null;
  userAlias: string | null;
  userRole: string | null;
  teams: string[];
}

/**
 * Render state of the identity lines: `ok` carries the allowlisted identity,
 * `no-credential` means there was no usable credential (S1/S2), and
 * `unavailable` carries a single-line reason for a failed /user/info fetch
 * (S1/S6). Alias resolution failures do not use this state: they degrade the
 * team line to the id-only form (S4).
 */
export type IdentityState =
  | { kind: "ok"; identity: GatewayIdentity }
  | { kind: "no-credential" }
  | { kind: "unavailable"; reason: string };

export interface ConnectionTeam {
  hasCredential: boolean;
  /** teamId fixed by the login consent (`credential.teamId`); null when absent. */
  teamId: string | null;
  /** Alias resolved via /team/list or /team/info; null = unresolved (id-only). */
  teamAlias: string | null;
}

export function emptyIdentity(): GatewayIdentity {
  return {
    userId: null,
    userEmail: null,
    userAlias: null,
    userRole: null,
    teams: [],
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function singleLine(reason: string): string {
  return reason.replace(/\s+/g, " ").trim();
}

/**
 * S1 — `User:` line. The identity value is email > alias > user_id; the
 * parenthetical lists the alias and role descriptors and never repeats the
 * identity value itself.
 */
export function formatUserLine(state: IdentityState): string {
  if (state.kind === "no-credential") return "User: no credential";
  if (state.kind === "unavailable") {
    return `User: unavailable (${singleLine(state.reason)})`;
  }
  const { userEmail, userAlias, userRole, userId } = state.identity;
  const identity = userEmail ?? userAlias ?? userId;
  if (!identity) return "User: unknown";
  const extras = [userAlias, userRole].filter(
    (value): value is string => !!value && value !== identity,
  );
  if (extras.length === 0) return `User: ${identity}`;
  return `User: ${identity} (${extras.join(", ")})`;
}

/**
 * S2 — `Team:` line. The team id comes from the local credential (no network
 * needed), so this line degrades to `alias unavailable` when alias resolution
 * fails instead of to an unavailable state.
 */
export function formatTeamLine(team: ConnectionTeam): string {
  if (!team.hasCredential) return "Team: no credential";
  if (!team.teamId) return "Team: none (no team bound)";
  if (team.teamAlias) return `Team: ${team.teamAlias} (${team.teamId})`;
  return `Team: ${team.teamId} (alias unavailable)`;
}

/**
 * Reduce a parsed /user/info payload to the S3 allowlist. `user_info` wins;
 * when absent (or for fields it lacks) the root level is used. A body that is
 * not a JSON object leaves the identity empty (User: unknown via S1); a
 * failed fetch, a non-2xx status, or an unparseable JSON body throws instead
 * (the caller surfaces `unavailable (<reason>)`, S6).
 */
function identityFromPayload(body: unknown): GatewayIdentity {
  const record = isRecord(body) ? body : {};
  const userInfo = isRecord(record.user_info) ? record.user_info : {};
  const pick = (key: string): string | null =>
    nonEmptyString(userInfo[key]) ?? nonEmptyString(record[key]);
  const teamsRaw = Array.isArray(userInfo.teams)
    ? userInfo.teams
    : Array.isArray(record.teams)
      ? record.teams
      : [];
  return {
    userId: pick("user_id"),
    userEmail: pick("user_email"),
    userAlias: pick("user_alias"),
    userRole: pick("user_role"),
    teams: teamsRaw.filter(
      (team): team is string => typeof team === "string" && team.length > 0,
    ),
  };
}

/**
 * Same request discipline as the budget helpers (budget.ts): positional
 * (baseUrl, path, apiKey, timeoutMs), Bearer auth, AbortSignal.timeout, typed
 * AuthError on 401/403 and CatalogError otherwise.
 */
async function gatewayJson(
  baseUrl: string,
  route: string,
  routeLabel: string,
  apiKey: string,
  timeoutMs: number,
): Promise<unknown> {
  const normalized = baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${normalized}${route}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new CatalogError(
      `Failed to fetch ${routeLabel}: ${fetchFailureMessage(err)}`,
      { cause: err },
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError("Credential rejected by gateway. Run /login again.");
  }

  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch ${routeLabel}: ${response.status}: ${response.statusText}`,
    );
  }

  try {
    return await response.json();
  } catch {
    // S5: a JSON parser message can quote the offending body (V8 includes a
    // snippet), and that body carries `keys[].token` in clear text. Never
    // surface the parser text, and never attach it as a cause.
    throw new CatalogError(`${routeLabel} response is not valid JSON`);
  }
}

/**
 * S3 — fetch and allowlist the connected user identity from /user/info.
 * Throws on fetch/network/401/403/JSON problems so the caller can degrade the
 * status lines with a reason (S6); a body that is not an object yields an
 * empty identity.
 */
export async function fetchGatewayIdentity(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<GatewayIdentity> {
  return identityFromPayload(
    await gatewayJson(baseUrl, "/user/info", "user info", apiKey, timeoutMs),
  );
}

/**
 * S4 — resolve the team alias, best-effort: /team/list (array body keyed by
 * team_id) first, then /team/info?team_id=. Any failure of either route
 * returns null so the caller shows the id-only form (S2); it must never break
 * the status (S6).
 */
export async function fetchTeamAlias(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  teamId: string,
): Promise<string | null> {
  try {
    const body = await gatewayJson(baseUrl, "/team/list", "team list", apiKey, timeoutMs);
    if (Array.isArray(body)) {
      const aliases = new Map<string, string>();
      for (const entry of body) {
        if (!isRecord(entry)) continue;
        const entryId = nonEmptyString(entry.team_id);
        const entryAlias = nonEmptyString(entry.team_alias);
        if (entryId && entryAlias && !aliases.has(entryId)) {
          aliases.set(entryId, entryAlias);
        }
      }
      const alias = aliases.get(teamId);
      if (alias) return alias;
    }
  } catch {
    // Best-effort: fall through to /team/info.
  }

  try {
    const body = await gatewayJson(
      baseUrl,
      `/team/info?team_id=${encodeURIComponent(teamId)}`,
      "team info",
      apiKey,
      timeoutMs,
    );
    if (isRecord(body)) return nonEmptyString(body.team_alias);
  } catch {
    // Best-effort: unresolved alias shows the id-only form (S2).
  }
  return null;
}
