import { AuthError, CatalogError } from "./errors.ts";
import { usageGauge } from "./usage.ts";
import { formatLocalDateTime } from "./datetime.ts";
import { GAUGE_ANSI_RESET_DIM, gaugeColorAnsi } from "./gauge-color.ts";
/**
/** Fixed window lengths of the Ollama subscription quotas. */
const SESSION_WINDOW_MS = 5 * 3_600_000;
const WEEK_WINDOW_MS = 7 * 24 * 3_600_000;
/**
 * Pace projection tuning: a just-started window would otherwise divide by a
 * near-zero elapsed span and explode the projection, so elapsed% never goes
 * below this floor; the linear projection itself caps at 200%.
 */
const MIN_ELAPSED_PERCENT = 10;
const MAX_PROJECTED_PERCENT = 200;

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Percent of the usage window that has already elapsed, or null when unknown.
 *
 * The quota reset instant (`resetsAt`, against the fixed window length) wins:
 * it is defined precisely for the reset window, matching the fixed 5h/weekly
 * lengths. The collector's `from`/`until` bounds are only trusted (when no
 * reset exists) while the window is still open (`until > now`): live collector
 * data sends `until ≈ generatedAt` as a closed measurement range end, which
 * would otherwise compute ~100% elapsed and silently disarm the pace rule
 * (regression #31). Callers pair this with the used% of the same window to
 * derive the consumption pace.
 */
function windowElapsedPercent(
  window: WindowUsage,
  quota: WindowQuota | null,
  weekly: boolean,
  now: number,
): number | null {
  const resetsAt = quota?.resetsAt;
  if (resetsAt) {
    const reset = Date.parse(resetsAt);
    if (Number.isFinite(reset)) {
      const length = weekly ? WEEK_WINDOW_MS : SESSION_WINDOW_MS;
      return clampPercent(((length - Math.max(0, reset - now)) / length) * 100);
    }
  }
  const from = window.from ? Date.parse(window.from) : NaN;
  const until = window.until ? Date.parse(window.until) : NaN;
  if (
    Number.isFinite(from) && Number.isFinite(until)
    && until > now && until > from
  ) {
    return clampPercent(((now - from) / (until - from)) * 100);
  }
  return null;
}

/**
 * Consumption pace: used% over elapsed% (floored), or null when the elapsed
 * span is unknown, so callers skip both escalation and projection.
 */
function paceOverElapsed(
  usedPercent: number,
  elapsedPercent: number | null,
): number | null {
  if (elapsedPercent == null) return null;
  return usedPercent / Math.max(elapsedPercent, MIN_ELAPSED_PERCENT);
}

/** Used% remapped into the next band below it so the color escalates one step. */
function escalatedUsedPercent(usedPercent: number, aheadOfPace: boolean): number {
  if (!aheadOfPace) return usedPercent;
  return usedPercent <= 50 ? 51
    : usedPercent <= 75 ? 76
    : usedPercent <= 90 ? 91
    : usedPercent;
}

/** " → N%" linear projection at the window's end, only when running ahead. */
function paceProjectionSuffix(usedPercent: number, elapsedPercent: number | null): string {
  const pace = paceOverElapsed(usedPercent, elapsedPercent);
  if (pace == null || pace <= 1) return "";
  const projected = Math.min(MAX_PROJECTED_PERCENT, Math.round(pace * 100));
  return ` → ${projected}%`;
}

const ANSI_SGR = /\x1b\[[0-9;]*m/g;

function visibleLength(cell: string): number {
  return cell.replace(ANSI_SGR, "").length;
}

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

/** Per-subscription usage returned by the single `/subs-usage` call. */
export interface SubscriptionUsage {
  name: string;
  /** Schema v2: "ollama" | "chatgpt" | "claude" | ... (absent on legacy payloads). */
  provider: string | null;
  /** Schema v2 account suffix inside the provider (legacy payloads: null). */
  account: string | null;
  /** Schema v2 status: ok | critical | error (legacy payloads: null). */
  status: string | null;
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
  const provider = asString(record.provider);
  return {
    name: asString(record.name) ?? asString(record.account) ?? "unknown",
    provider,
    account: asString(record.account),
    status: asString(record.status),
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
 * Fetches subscription usage from the gateway's pass-through endpoint.
 *
 * Canonical route is `GET /subs-usage` (schema v2: one flat list for every
 * provider). Gateways deployed before the rename only expose
 * `/ollama-usage`, so a 404 falls back to it (both serve the same report).
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
  const headers = { Authorization: `Bearer ${apiKey}` };
  const request = (path: string): Promise<Response> =>
    fetch(`${normalized}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });

  let response: Response;
  try {
    response = await request("/subs-usage");
    if (response.status === 404) {
      // Gateway predates the rename: the legacy alias serves the same report.
      response = await request("/ollama-usage");
    }
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

/**
 * Window cell for the /usage-subs table, in /usage's gauge-or-absolute discipline.
 * `weekly` selects the known quota window length; `now` anchors the elapsed
 * span against the reset instants and window bounds.
 */
function formatWindowCell(
  window: WindowUsage,
  quota: WindowQuota | null,
  weekly: boolean,
  color: boolean,
  now: number,
): string {
  const usage = window.usageUsd ?? 0;
  const elapsed = windowElapsedPercent(window, quota, weekly, now);

  // Legacy-plan dashboard quota wins: remaining % (used = 100 - remaining).
  if (quota != null && quota.remainingPercent != null) {
    const used = clampPercent(100 - quota.remainingPercent);
    const pace = paceOverElapsed(used, elapsed);
    const ahead = pace != null && pace > 1;
    const run = `${usageGauge(used)} ${Math.round(used)}%${paceProjectionSuffix(used, elapsed)}`;
    return color
      ? `${gaugeColorAnsi(escalatedUsedPercent(used, ahead))}${run}${GAUGE_ANSI_RESET_DIM}`
      : run;
  }

  if (window.limitUsd != null) {
    const limit = window.limitUsd;
    const percent =
      limit > 0
        ? clampPercent((usage / limit) * 100)
        : usage > 0
          ? 100
          : 0;
    const pace = paceOverElapsed(percent, elapsed);
    const ahead = pace != null && pace > 1;
    const run = `${usageGauge(percent)} $${usage.toFixed(2)} / $${limit.toFixed(2)}${paceProjectionSuffix(percent, elapsed)}`;
    return color
      ? `${gaugeColorAnsi(escalatedUsedPercent(percent, ahead))}${run}${GAUGE_ANSI_RESET_DIM}`
      : run;
  }

  // No quota and no money for this window (e.g. an idle plan window): a dash
  // keeps the table narrow — request/token counters were dropped on purpose.
  return "-";
}

/** Remaining reset duration, rounded up to the window's smallest displayed unit. */
function formatResetsCell(quota: WindowQuota | null, weekly: boolean, now: number): string {
  const resetsAt = quota?.resetsAt;
  // Upstream does not send a reset clock while a window is idle: Anthropic
  // returns five_hour.resets_at = null (and isActive: false) until the window
  // is used again. Show "full" instead of a bare dash so it is not read as an
  // error or as missing data.
  if (!resetsAt) return quota?.remainingPercent === 100 ? "full" : "-";
  const reset = Date.parse(resetsAt);
  if (!Number.isFinite(reset)) return "-";
  const remaining = Math.max(0, reset - now);
  if (weekly) {
    const hours = Math.ceil(remaining / 3_600_000);
    return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  }
  const minutes = Math.ceil(remaining / 60_000);
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function creditsCell(credits: SubscriptionCredits): string | null {
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
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Renders the per-subscription usage as an aligned fixed-width table in the
 * /usage command's discipline: padded header row, "-" separator, no totals row
 * (subscriptions are separate accounts). Error subscriptions render their
 * `(error: ...)` in the first window cell with dashes elsewhere.
 *
 * With `{color: true}` the gauge cells carry ANSI truecolor thresholds
 * (green/yellow/orange/red over used%, escalated one level and paired with a
 * linear projection suffix when consumption runs ahead of the elapsed window)
 * and run through terminals fine: the notify path supports embedded SGR and
 * the width math strips it. Padding is measured on visible length so colored
 * cells stay aligned.
 */
export function formatUsageSubsLines(
  data: UsageSubscriptions,
  options: { color?: boolean } = {},
): string[] {
  const color = options.color === true;
  const now = Date.now();
  const lines: string[] = [];
  const generatedAt = formatLocalDateTime(data.generatedAt) ?? "-";
  lines.push(`Usage subscriptions (generated at ${generatedAt}):`);

  if (data.subscriptions.length === 0) {
    lines.push("(no subscriptions returned)");
    return lines;
  }

  const header = ["Sub", "5h used", "5h resets in", "Weekly used", "Weekly resets in", "Credits"];
  // Schema v2 names the provider in each record: surface it in the Sub cell.
  // Legacy payloads have no provider and keep the previous label verbatim.
  const subLabel = (sub: SubscriptionUsage): string =>
    sub.provider ? `${sub.provider}:${sub.name}` : sub.name;
  const rows = data.subscriptions.map((sub) => [
    subLabel(sub),
    sub.error ? `(error: ${sub.error})` : formatWindowCell(sub.session5h, sub.credits.session, false, color, now),
    sub.error ? "-" : formatResetsCell(sub.credits.session, false, now),
    sub.error ? "-" : formatWindowCell(sub.weekly, sub.credits.weekly, true, color, now),
    sub.error ? "-" : formatResetsCell(sub.credits.weekly, true, now),
    sub.error ? "-" : creditsCell(sub.credits) ?? "-",
  ]);

  const width = header.map((_, i) =>
    Math.max(header[i].length, ...rows.map((row) => visibleLength(row[i]))));
  const renderRow = (cells: string[]): string =>
    cells.map((cell, i) => visibleLength(cell) < width[i]
      ? cell + " ".repeat(width[i] - visibleLength(cell))
      : cell,
    ).join("  ").trimEnd();

  lines.push(renderRow(header));
  lines.push("-".repeat(renderRow(header).length));
  for (const row of rows) {
    lines.push(renderRow(row));
  }
  return lines;
}
