import { AuthError, CatalogError } from "./errors.ts";

export interface BudgetInfo {
  spend: number | null;
  maxBudget: number | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  budgetResetAt: number | null;
  keyAlias: string | null;
}

interface KeyInfoResponse {
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
  const normalized = baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${normalized}/key/info`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new CatalogError(
      `Failed to fetch budget info: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError("Credential rejected by gateway. Run /login again.");
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
    : {}) as KeyInfoResponse;

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
