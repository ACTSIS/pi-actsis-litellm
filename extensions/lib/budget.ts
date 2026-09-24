import { AuthError, CatalogError } from "./errors.ts";
import { fetchFailureMessage } from "./network-error.ts";

export interface BudgetInfo {
  spend: number | null;
  maxBudget: number | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  budgetResetAt: number | null;
  keyAlias: string | null;
}

interface KeyInfoResponse {
  info?: unknown;
  spend?: number;
  max_budget?: number;
  tpm_limit?: number;
  rpm_limit?: number;
  budget_reset_at?: unknown;
  key_alias?: string;
}

function parseBudgetResetAt(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    // Accept epoch seconds or milliseconds for the next ~1000 years.
    if (value < 1_000_000_000_000) {
      return value * 1000;
    }
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function asNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export async function fetchBudgetInfo(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<BudgetInfo> {
  try {
    return await fetchKeyInfoBudget(baseUrl, apiKey, timeoutMs);
  } catch (err) {
    // SSO credentials are not LiteLLM virtual keys, so /key/info rejects them
    // (404/500 from the proxy). Fall back to /user/info, which accepts the
    // SSO token and reports the user-level spend/budget.
    if (err instanceof AuthError) throw err;
    return fetchUserInfoBudget(baseUrl, apiKey, timeoutMs);
  }
}

/**
 * Maps a 401/403 budget response to the most accurate error: a virtual key
 * without the `info_routes` permission gets a 403 with a LiteLLM `detail`
 * message that re-login cannot fix, so it must not read as "run /login".
 */
async function authErrorFor(response: Response): Promise<AuthError> {
  let detail = "";
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail) detail = body.detail;
  } catch {
    // Body is not JSON or unreadable; fall back to the generic message.
  }
  if (response.status === 403 && detail) {
    return new AuthError(
      `Gateway denied access to budget info (403): ${detail}. Ask a gateway admin to grant the key the info_routes permission.`,
    );
  }
  return new AuthError("Credential rejected by gateway. Run /login again.");
}

async function fetchKeyInfoBudget(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<BudgetInfo> {
  const normalized = baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${normalized}/key/info`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new CatalogError(
      `Failed to fetch budget info: ${fetchFailureMessage(err)}`,
      { cause: err },
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw await authErrorFor(response);
  }

  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch budget info: ${response.status}: ${response.statusText}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new CatalogError(
      `Budget info response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const bodyRecord = typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : {};
  // LiteLLM >= 1.100.1 nests the key record under `info`
  // (GET /key/info -> { key: string, info: <VerificationToken> }); older
  // versions returned the fields at the top level. Flatten defensively so
  // both shapes parse, with `info` winning when present.
  const infoRecord =
    typeof bodyRecord.info === "object" && bodyRecord.info !== null
      ? (bodyRecord.info as Record<string, unknown>)
      : {};
  const record = { ...bodyRecord, ...infoRecord } as KeyInfoResponse;

  return {
    spend: asNullableNumber(record.spend),
    maxBudget: asNullableNumber(record.max_budget),
    tpmLimit: asNullableNumber(record.tpm_limit),
    rpmLimit: asNullableNumber(record.rpm_limit),
    budgetResetAt: parseBudgetResetAt(record.budget_reset_at),
    keyAlias:
      typeof record.key_alias === "string" && record.key_alias
        ? record.key_alias
        : null,
  };
}

interface UserInfoResponse {
  user_info?: {
    spend?: unknown;
    max_budget?: unknown;
    user_alias?: unknown;
  };
}

/**
 * Fallback for SSO credentials: /user/info accepts the SSO token and reports
 * user-level spend and budget (no per-key limits apply).
 */
async function fetchUserInfoBudget(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<BudgetInfo> {
  const normalized = baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${normalized}/user/info`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new CatalogError(
      `Failed to fetch budget info: ${fetchFailureMessage(err)}`,
      { cause: err },
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw await authErrorFor(response);
  }

  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch budget info: ${response.status}: ${response.statusText}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new CatalogError(
      `Budget info response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const record = (typeof body === "object" && body !== null
    ? body
    : {}) as UserInfoResponse;
  const ui = record.user_info ?? {};

  return {
    spend: asNullableNumber(ui.spend),
    maxBudget: asNullableNumber(ui.max_budget),
    tpmLimit: null,
    rpmLimit: null,
    budgetResetAt: null,
    keyAlias:
      typeof ui.user_alias === "string" && ui.user_alias ? ui.user_alias : null,
  };
}


export function budgetUsagePercent(
  spend: number | null,
  maxBudget: number | null,
): number {
  if (maxBudget === null || maxBudget <= 0) return 0;
  return ((spend ?? 0) / maxBudget) * 100;
}

export function formatBudgetLine(info: BudgetInfo): string | null {
  if (info.spend === null) return null;
  const percent = budgetUsagePercent(info.spend, info.maxBudget);
  const capPart =
    info.maxBudget !== null
      ? ` / $${info.maxBudget.toFixed(2)} used (${Math.round(percent)}%)`
      : ` used (no budget cap)`;
  let line = `$${info.spend.toFixed(2)}${capPart}`;
  if (info.budgetResetAt !== null) {
    const time = new Date(info.budgetResetAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    line += ` | resets ${time}`;
  }
  return line;
}
