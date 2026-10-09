import { AuthError, CatalogError } from "./errors.ts";

/** Single model's aggregated usage over the queried range. */
export interface ModelUsageEntry {
  model: string;
  spend: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  apiRequests: number | null;
}

/** Aggregated per-model usage for the queried date range (inclusive). */
export interface ModelUsageSummary {
  startDate: string;
  endDate: string;
  totals: {
    spend: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    apiRequests: number | null;
  };
  models: ModelUsageEntry[];
}

/** Inclusive date range in YYYY-MM-DD format. */
export interface UsageRange {
  startDate: string;
  endDate: string;
}

interface DailyActivityResponse {
  results?: unknown;
  metadata?: unknown;
}

interface MetricsLike {
  spend?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  api_requests?: unknown;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function asNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function isoDay(ms: number): string {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseIsoDayOrNull(value: string | undefined | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

function addDays(isoDay: string, days: number): string {
  const base = parseIsoDayOrNull(isoDay);
  if (base === null) return isoDay;
  return isoDayUTC(base + days * DAY_MS);
}

// Internal helper mirroring isoDay but keeping the public surface small.
function isoDayUTC(ms: number): string {
  return isoDay(ms);
}

/** Default query range: the last 30 days, inclusive of today (UTC). */
export function resolveDefaultUsageRange(nowMs?: number): UsageRange {
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const endDate = isoDay(now);
  return { startDate: addDays(endDate, -29), endDate };
}

async function requestDailyActivity(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  range: UsageRange,
): Promise<Response> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const url = `${normalized}/user/daily/activity?start_date=${encodeURIComponent(range.startDate)}&end_date=${encodeURIComponent(range.endDate)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new CatalogError(
      `Failed to fetch model usage: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (response.status === 401) {
    throw new AuthError("Credential rejected by gateway. Run /login again.");
  }
  if (response.status === 403) {
    throw new AuthError(
      "Gateway denied access to usage info (403): this credential lacks the spend/usage routes permission. Ask a gateway admin to grant it.",
    );
  }
  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch model usage: ${response.status}: ${response.statusText}`,
    );
  }
  return response;
}

function readMetrics(record: Record<string, unknown>): MetricsLike {
  const nested = asRecord(record.metrics);
  // LiteLLM daily-activity shape: metrics live under `metrics` (rows) and
  // `breakdown.models[<model>].metrics`; older builds may expose flat fields.
  return { ...record, ...nested } as MetricsLike;
}

function accumulate(
  totals: MetricsAggregator,
  metrics: MetricsLike,
): void {
  totals.spend += asNullableNumber(metrics.spend) ?? 0;
  totals.promptTokens += asNullableNumber(metrics.prompt_tokens) ?? 0;
  totals.completionTokens += asNullableNumber(metrics.completion_tokens) ?? 0;
  totals.totalTokens += asNullableNumber(metrics.total_tokens) ?? 0;
  totals.apiRequests += asNullableNumber(metrics.api_requests) ?? 0;
}

interface MetricsAggregator {
  spend: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  apiRequests: number;
}

function newAggregator(): MetricsAggregator {
  return { spend: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, apiRequests: 0 };
}

function toSummary(
  range: UsageRange,
  totals: MetricsAggregator,
  perModel: Map<string, MetricsAggregator>,
): ModelUsageSummary {
  const models: ModelUsageEntry[] = [...perModel.entries()]
    .map(([model, agg]) => ({
      model,
      spend: agg.spend,
      promptTokens: agg.promptTokens,
      completionTokens: agg.completionTokens,
      totalTokens: agg.totalTokens,
      apiRequests: agg.apiRequests,
    }))
    .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0) || a.model.localeCompare(b.model));
  return {
    startDate: range.startDate,
    endDate: range.endDate,
    totals: {
      spend: totals.spend,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
      apiRequests: totals.apiRequests,
    },
    models,
  };
}

/**
 * Fetches per-model usage from the LiteLLM proxy's
 * `GET /user/daily/activity` endpoint (daily spend/tokens/requests with a
 * per-model breakdown). Spend is only calculated for OpenAI-compatible
 * `/v1/chat/completions` traffic; `/v1/messages`, passthrough, and unlogged
 * requests report zero or are absent.
 */
export async function fetchModelUsage(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  range?: Partial<UsageRange>,
): Promise<ModelUsageSummary> {
  const effectiveRange: UsageRange = {
    startDate: range?.startDate ?? resolveDefaultUsageRange().startDate,
    endDate: range?.endDate ?? resolveDefaultUsageRange().endDate,
  };
  const response = await requestDailyActivity(
    baseUrl,
    apiKey,
    timeoutMs,
    effectiveRange,
  );

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new CatalogError(
      `Model usage response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const record = asRecord(body);
  const results = Array.isArray(record.results) ? record.results : [];
  const totalsAgg = newAggregator();
  const perModel = new Map<string, MetricsAggregator>();
  const metadata = asRecord(record.metadata);

  for (const rawRow of results) {
    const row = asRecord(rawRow);

    accumulate(totalsAgg, readMetrics(row));

    const breakdown = asRecord(row.breakdown);
    const models = asRecord(breakdown.models);
    for (const [model, rawMetrics] of Object.entries(models)) {
      const agg = perModel.get(model) ?? newAggregator();
      accumulate(agg, readMetrics(asRecord(rawMetrics)));
      perModel.set(model, agg);
    }
  }

  // Apply the endpoint's own metadata totals per field, falling back to the
  // summed row metrics for any missing key. This covers pages where rows are
  // empty or partial while metadata carries the authoritative totals (and
  // avoids double counting rows outside the `results` pagination window).
  const metadataFields: Array<[keyof MetricsAggregator, unknown]> = [
    ["spend", metadata.total_spend],
    ["promptTokens", metadata.total_prompt_tokens],
    ["completionTokens", metadata.total_completion_tokens],
    ["totalTokens", metadata.total_tokens],
    ["apiRequests", metadata.total_api_requests],
  ];
  for (const [field, value] of metadataFields) {
    const n = asNullableNumber(value);
    if (n !== null) totalsAgg[field] = n;
  }

  // Floor: the per-model breakdown is the minimum credible spend even when
  // metadata totals look stale or partially populated.
  const modelSpendSum = [...perModel.values()].reduce((sum, m) => sum + m.spend, 0);
  if (perModel.size > 0 && modelSpendSum > totalsAgg.spend) {
    totalsAgg.spend = modelSpendSum;
  }

  return toSummary(effectiveRange, totalsAgg, perModel);
}

/**
 * Maps LiteLLM spend-log model keys (internal deployment names like
 * "openai/glm-5.3-flash") to the public catalog ids users know ("oc/glm-5.3-flash").
 * Exact public ids pass through (no entry); unknown keys are left untouched.
 * Ambiguous suffixes resolve deterministically to the sorted-first public id.
 */
export function mapModelAliases(
  modelKeys: string[],
  publicIds: string[],
): Map<string, string> {
  const aliases = new Map<string, string>();
  const publicSet = new Set(publicIds);

  const suffixIndex = new Map<string, string>();
  for (const id of [...publicIds].sort()) {
    const suffix = id.split("/").pop()!.toLowerCase();
    if (!suffixIndex.has(suffix)) suffixIndex.set(suffix, id);
  }

  for (const key of modelKeys) {
    if (!key || publicSet.has(key)) continue;
    const normalized = key.split("/").pop()!.toLowerCase();
    const publicId = suffixIndex.get(normalized);
    if (publicId) aliases.set(key, publicId);
  }
  return aliases;
}

/**
 * Renames + merges model entries at display time using the alias map.
 * Totals stay untouched (merging only changes row presentation); the input
 * is never mutated.
 */
export function applyModelAliases(
  summary: ModelUsageSummary,
  aliases: Map<string, string>,
): ModelUsageSummary {
  if (aliases.size === 0) {
    return { ...summary, models: summary.models.map((m) => ({ ...m })) };
  }

  const merged = new Map<string, ModelUsageEntry>();
  for (const entry of summary.models) {
    const name = aliases.get(entry.model) ?? entry.model;
    const existing = merged.get(name);
    if (existing) {
      existing.spend = (existing.spend ?? 0) + (entry.spend ?? 0);
      existing.promptTokens = (existing.promptTokens ?? 0) + (entry.promptTokens ?? 0);
      existing.completionTokens =
        (existing.completionTokens ?? 0) + (entry.completionTokens ?? 0);
      existing.totalTokens = (existing.totalTokens ?? 0) + (entry.totalTokens ?? 0);
      existing.apiRequests = (existing.apiRequests ?? 0) + (entry.apiRequests ?? 0);
    } else {
      merged.set(name, { ...entry, model: name });
    }
  }

  return {
    ...summary,
    models: [...merged.values()].sort(
      (a, b) => (b.spend ?? 0) - (a.spend ?? 0) || a.model.localeCompare(b.model),
    ),
  };
}

/** Number of seconds between two YYYY-MM-DD strings (inclusive length). */
export function rangeLengthDays(range: UsageRange): number {
  const start = parseIsoDayOrNull(range.startDate);
  const end = parseIsoDayOrNull(range.endDate);
  if (start === null || end === null) return 0;
  return Math.round((end - start) / DAY_MS) + 1;
}

/** Formats one model row, e.g. `gpt-x  $0.0200  460 tok  5 reqs`. */
export function formatUsageModelLine(entry: ModelUsageEntry): string {
  const spend =
    entry.spend === null || entry.spend === undefined
      ? "$-.--"
      : `$${entry.spend.toFixed(4)}`;
  const tokens = entry.totalTokens === null || entry.totalTokens === undefined
    ? "-"
    : String(entry.totalTokens);
  const requests = entry.apiRequests === null || entry.apiRequests === undefined
    ? "-"
    : String(entry.apiRequests);
  return `${entry.model}  ${spend}  ${tokens} tok  ${requests} reqs`;
}

/** Formats the whole summary as display lines (no leading slash command name). */
export function formatUsageLines(summary: ModelUsageSummary): string[] {
  const lines: string[] = [];
  const spend = summary.totals.spend ?? 0;
  const totalTokens = summary.totals.totalTokens ?? 0;
  const apiRequests = summary.totals.apiRequests ?? 0;
  lines.push(
    `Usage ${summary.startDate} → ${summary.endDate} (${rangeLengthDays(summary)} days): spend $${spend.toFixed(4)}, ${totalTokens} tokens, ${apiRequests} requests`,
  );
  if (summary.models.length === 0) {
    lines.push("  (no logged model usage in this range)");
    return lines;
  }
  for (const entry of summary.models) {
    lines.push(`  ${formatUsageModelLine(entry)}`);
  }
  return lines;
}


