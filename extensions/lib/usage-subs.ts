import { AuthError, CatalogError } from "./errors.ts";
import { usageGauge } from "./usage.ts";

/** Rolling 5h window or weekly totals for one subscription. */
export interface WindowUsage {
  usageUsd: number | null;
  limitUsd: number | null;
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  from: string | null;
  until: string | null;
}

/** Credit balance breakdown reported by the collector. */
export interface SubscriptionCredits {
  includedUsd: number | null;
  includedBalanceUsd: number | null;
  purchasedUsd: number | null;
  /** Legacy-plan window quotas (the dashboard's % per window); credit plans null. */
  session: WindowQuota | null;
  weekly: WindowQuota | null;
}

/** Remaining percent of a 5h/weekly usage window, as Ollama's dashboard shows. */
export interface WindowQuota {
  remainingPercent: number | null;
  resetsAt: string | null;
}

/** Per-subscription usage returned by the single `/ollama-usage` call. */
export interface SubscriptionUsage {
  name: string;
  plan: string | null;
  session5h: WindowUsage;
  weekly: WindowUsage;
  credits: SubscriptionCredits;
  error: string | null;
}

/** Canonical S6 collector response, parsed null-tolerantly. */
export interface UsageSubscriptions {
  generatedAt: string | null;
  subscriptions: SubscriptionUsage[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asWindowUsage(value: unknown): WindowUsage {
  const record = asRecord(value);
  return {
    usageUsd: asNullableNumber(record.usageUsd),
    limitUsd: asNullableNumber(record.limitUsd),
    requests: asNullableNumber(record.requests),
    inputTokens: asNullableNumber(record.inputTokens),
    outputTokens: asNullableNumber(record.outputTokens),
    from: asString(record.from),
    until: asString(record.until),
  };
}

function asQuota(value: unknown): WindowQuota | null {
  const record = asRecord(value);
  if (record.remainingPercent === undefined) return null;
  return {
    remainingPercent: asNullableNumber(record.remainingPercent),
    resetsAt: asString(record.resetsAt),
  };
}

function asCredits(value: unknown): SubscriptionCredits {
  const record = asRecord(value);
  return {
    includedUsd: asNullableNumber(record.includedUsd),
    includedBalanceUsd: asNullableNumber(record.includedBalanceUsd),
    purchasedUsd: asNullableNumber(record.purchasedUsd),
    session: asQuota(record.session),
    weekly: asQuota(record.weekly),
  };
}

function asSubscription(value: unknown): SubscriptionUsage {
  const record = asRecord(value);
  return {
    name: asString(record.name) ?? "unknown",
    plan: asString(record.plan),
    session5h: asWindowUsage(record.session5h),
    weekly: asWindowUsage(record.weekly),
    credits: asCredits(record.credits),
    error: asString(record.error),
  };
}

function parseUsageSubscriptions(body: unknown): UsageSubscriptions {
  const record = asRecord(body);
  return {
    generatedAt: asString(record.generatedAt),
    subscriptions: asArray(record.subscriptions).map(asSubscription),
  };
}

/**
 * Fetches per-subscription Ollama Cloud usage from the gateway's single
 * `GET /ollama-usage` pass-through endpoint.
 *
 * The collector returns both the rolling 5h window (`session5h`) and the weekly
 * window in one response, so the plugin issues exactly one upstream GET. The
 * S6 collector contract is parsed null-tolerantly: absent optional fields default
 * to null/0 and never throw.
 *
 * 404 is treated as "the gateway does not expose this route" and surfaced as a
 * CatalogError with the message "usage-subs endpoint not available". 401/403 are
 * surfaced as AuthError with the same wording used by /usage.
 */
export async function fetchUsageSubs(
  gatewayUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<UsageSubscriptions> {
  const normalized = gatewayUrl.replace(/\/+$/, "");
  const url = `${normalized}/ollama-usage`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new CatalogError(
      `Failed to fetch usage-subs: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (response.status === 404) {
    throw new CatalogError("usage-subs endpoint not available");
  }
  if (response.status === 401) {
    throw new AuthError("Credential rejected by gateway. Run /login again.");
  }
  if (response.status === 403) {
    throw new AuthError(
      "Gateway denied access to usage-subs (403): this credential lacks the spend/usage routes permission. Ask a gateway admin to grant it.",
    );
  }
  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch usage-subs: ${response.status}: ${response.statusText}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new CatalogError(
      `Failed to fetch usage-subs: response was not valid JSON`,
      { cause: err },
    );
  }

  return parseUsageSubscriptions(body);
}

/** Legacy-plan window line: the dashboard's own remaining % (used = 100-remaining). */
function formatQuotaLine(label: string, quota: WindowQuota, requests: number | null): string {
  const remaining = quota.remainingPercent ?? 0;
  const used = Math.min(100, Math.max(0, 100 - remaining));
  const resets = quota.resetsAt ? ` · resets ${quota.resetsAt}` : "";
  const reqs = requests != null ? ` · ${requests.toLocaleString("en-US")} reqs` : "";
  return `${label}: ${usageGauge(used)} ${Math.round(used)}% used${reqs}${resets}`;
}

function formatWindowLine(label: string, window: WindowUsage, quota: WindowQuota | null): string {
  const usage = window.usageUsd ?? 0;
  const requests = window.requests ?? 0;
  const tokens = (window.inputTokens ?? 0) + (window.outputTokens ?? 0);

  if (quota != null && quota.remainingPercent != null) {
    return formatQuotaLine(label, quota, requests);
  }

  if (window.limitUsd != null) {
    const limit = window.limitUsd;
    const percent =
      limit > 0
        ? Math.min(100, Math.max(0, (usage / limit) * 100))
        : usage > 0
          ? 100
          : 0;
    return `${label}: ${usageGauge(percent)} ${Math.round(percent)}% · $${usage.toFixed(2)} / $${limit.toFixed(2)}`;
  }

  return `${label}: $${usage.toFixed(2)} / ${requests.toLocaleString("en-US")} reqs / ${tokens.toLocaleString("en-US")} tokens`;
}

function formatCreditsLine(credits: SubscriptionCredits): string | null {
  const parts: string[] = [];
  if (credits.includedUsd != null) {
    parts.push(`included $${credits.includedUsd.toFixed(2)}`);
  }
  if (credits.includedBalanceUsd != null) {
    parts.push(`balance $${credits.includedBalanceUsd.toFixed(2)}`);
  }
  if (credits.purchasedUsd != null) {
    parts.push(`purchased $${credits.purchasedUsd.toFixed(2)}`);
  }
  return parts.length > 0 ? `Credits: ${parts.join(" · ")}` : null;
}

/** Renders the per-subscription usage block returned by fetchUsageSubs. */
export function formatUsageSubsLines(data: UsageSubscriptions): string[] {
  const lines: string[] = [];
  const generatedAt = data.generatedAt ?? "-";
  lines.push(`Usage subscriptions (generated at ${generatedAt}):`);

  if (data.subscriptions.length === 0) {
    lines.push("(no subscriptions returned)");
    return lines;
  }

  for (const sub of data.subscriptions) {
    const planSuffix = sub.plan ? ` (${sub.plan})` : "";
    lines.push(`Subscription: ${sub.name}${planSuffix}`);

    if (sub.error) {
      lines.push(`  Error: ${sub.error}`);
      continue;
    }

    lines.push(`  ${formatWindowLine("5h", sub.session5h, sub.credits.session)}`);
    lines.push(`  ${formatWindowLine("Weekly", sub.weekly, sub.credits.weekly)}`);
    const credits = formatCreditsLine(sub.credits);
    if (credits) {
      lines.push(`  ${credits}`);
    }
  }

  return lines;
}
