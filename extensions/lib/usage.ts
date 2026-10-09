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
  filters: { userId?: string; aggregated: boolean; page?: number; pageSize?: number },
): Promise<{ ok: boolean; status: number; found: boolean; body?: unknown }> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const path = filters.aggregated
    ? `${normalized}/user/daily/activity/aggregated`
    : `${normalized}/user/daily/activity`;
  const params = new URLSearchParams({
    start_date: range.startDate,
    end_date: range.endDate,
  });
  if (filters.userId) params.set("user_id", filters.userId);
  if (filters.page !== undefined) params.set("page", String(filters.page));
  if (filters.pageSize !== undefined) params.set("page_size", String(filters.pageSize));
  const url = `${path}?${params.toString()}`;
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
  if (response.status === 404 || response.status === 405) {
    // Endpoint not offered by this proxy build; the caller falls back.
    return { ok: false, status: response.status, found: false };
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
  return { ok: true, status: response.status, found: true, body: await response.json() };
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
const MAX_USAGE_PAGES = 50;
const USAGE_PAGE_SIZE = 200;

interface UsagePage {
  results: Record<string, unknown>[];
  metadata: Record<string, unknown>;
  hasMore: boolean;
  totalPages: number | null;
}

function parseUsagePage(body: unknown): UsagePage {
  const record = asRecord(body);
  const metadata = asRecord(record.metadata);
  return {
    results: Array.isArray(record.results) ? record.results.map(asRecord) : [],
    metadata,
    hasMore: metadata.has_more === true,
    totalPages:
      asNullableNumber(metadata.total_pages) === null
        ? null
        : (asNullableNumber(metadata.total_pages) as number),
  };
}

/**
 * Fetches per-model usage, mirroring the LiteLLM dashboard's "Your Usage"
 * view:
 *
 * 1. Primary: `GET /user/daily/activity/aggregated` — stable, query-scoped
 *    totals in one call (the paginated endpoint's per-page metadata is
 *    page-scoped and its totals are unreliable — LiteLLM issue #30164).
 * 2. Fallback (older proxies): the paginated `GET /user/daily/activity`,
 *    walking every page (page_size 200) and summing rows client-side; the
 *    per-page metadata is adopted only when the response fits a single page.
 *
 * `userId` scopes the query to the credential's own user ("Your Usage");
 * without it an admin token sees the whole organization.
 *
 * NOTE: request counts here come from spend logs and count each upstream
 * attempt separately; use fetchGatewayRequests for the gateway's answered
 * requests (the dashboard's Total Requests card).
 */
export async function fetchModelUsage(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  range?: Partial<UsageRange>,
  options: { userId?: string } = {},
): Promise<ModelUsageSummary> {
  const effectiveRange: UsageRange = {
    startDate: range?.startDate ?? resolveDefaultUsageRange().startDate,
    endDate: range?.endDate ?? resolveDefaultUsageRange().endDate,
  };

  // Aggregated first (when the proxy offers it).
  const aggregated = await requestDailyActivity(baseUrl, apiKey, timeoutMs, effectiveRange, {
    userId: options.userId,
    aggregated: true,
  });
  if (aggregated.found && aggregated.body !== undefined) {
    return summarizeUsage(effectiveRange, [parseUsagePage(aggregated.body)], {
      adoptMetadataTotals: true,
    });
  }

  // Paginated walk of the classic endpoint.
  const pages: UsagePage[] = [];
  for (let page = 1; page <= MAX_USAGE_PAGES; page++) {
    const result = await requestDailyActivity(baseUrl, apiKey, timeoutMs, effectiveRange, {
      userId: options.userId,
      aggregated: false,
      page,
      pageSize: USAGE_PAGE_SIZE,
    });
    if (result.found && result.body !== undefined) {
      const parsed = parseUsagePage(result.body);
      pages.push(parsed);
      if (!parsed.hasMore) break;
    } else {
      break; // endpoint unavailable (404/405)
    }
  }
  if (pages.length === 0) {
    throw new CatalogError("Failed to fetch model usage: no usage endpoint available");
  }
  const singlePage = pages.length === 1 && pages[0].totalPages !== null && pages[0].totalPages <= 1;
  return summarizeUsage(effectiveRange, pages, {
    adoptMetadataTotals: singlePage,
  });
}

function summarizeUsage(
  range: UsageRange,
  pages: UsagePage[],
  opts: { adoptMetadataTotals: boolean },
): ModelUsageSummary {
  const totalsAgg = newAggregator();
  const perModel = new Map<string, MetricsAggregator>();

  for (const pageData of pages) {
    for (const row of pageData.results) {
      accumulate(totalsAgg, readMetrics(row));
      const breakdown = asRecord(row.breakdown);
      const models = asRecord(breakdown.models);
      for (const [model, rawMetrics] of Object.entries(models)) {
        const agg = perModel.get(model) ?? newAggregator();
        accumulate(agg, readMetrics(asRecord(rawMetrics)));
        perModel.set(model, agg);
      }
    }
  }

  // Metadata totals are query-scoped only when everything fit one page
  // (the aggregated endpoint, or a single full page of the classic one).
  // Otherwise they are page-scoped and summing the rows is the only way to
  // get correct query totals.
  if (opts.adoptMetadataTotals && pages.length === 1) {
    const metadata = pages[0].metadata;
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
  }

  // Floor: the per-model breakdown is the minimum credible spend even when
  // metadata totals look stale or partially populated.
  const modelSpendSum = [...perModel.values()].reduce((sum, m) => sum + m.spend, 0);
  if (modelSpendSum > totalsAgg.spend) {
    totalsAgg.spend = modelSpendSum;
  }

  return toSummary(range, totalsAgg, perModel);
}

/**
 * Gateway-answered request counts (`GET /gateway/daily/activity`), the
 * dashboard's Total Requests source. Includes traffic not logged in the
 * spend tables (audio, passthrough, ...), so totals differ from the
 * daily-activity endpoint; returns null when the proxy lacks the endpoint.
 */
export async function fetchGatewayRequests(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  range: Partial<UsageRange>,
  options: { userId?: string } = {},
): Promise<{ successful: number; failed: number; total: number } | null> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({
    start_date: range.startDate ?? resolveDefaultUsageRange().startDate,
    end_date: range.endDate ?? resolveDefaultUsageRange().endDate,
  });
  if (options.userId) params.set("user_id", options.userId);
  let response: Response;
  try {
    response = await fetch(`${normalized}/gateway/daily/activity?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new CatalogError(
      `Failed to fetch gateway activity: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (response.status === 404 || response.status === 405) return null;
  if (response.status === 401) {
    throw new AuthError("Credential rejected by gateway. Run /login again.");
  }
  if (response.status === 403) {
    throw new AuthError(
      "Gateway denied access to gateway activity (403): this credential lacks the required permission. Ask a gateway admin to grant it.",
    );
  }
  if (!response.ok) {
    throw new CatalogError(
      `Failed to fetch gateway activity: ${response.status}: ${response.statusText}`,
    );
  }
  const record = asRecord(await response.json());
  // Some builds expose the totals at the top level, others under `metadata`;
  // merge both with metadata winning when present.
  const metadata = asRecord(record.metadata);
  const merged = { ...record, ...metadata };
  const successful = asNullableNumber(merged.total_successful_requests) ?? 0;
  const failed = asNullableNumber(merged.total_failed_requests) ?? 0;
  const totalMeta = asNullableNumber(merged.total_requests);
  return { successful, failed, total: totalMeta ?? successful + failed };
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

/** Compact human-readable token count; null renders as dash. */
export function formatCompactTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return "-";
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(2)}B`;
  if (tokens >= 1e6) {
    const millions = tokens / 1e6;
    return `${millions.toFixed(millions < 10 ? 2 : 1)}M`;
  }
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k`;
  return String(tokens);
}

export function resolveUsageRangeDays(days: number, nowMs?: number): UsageRange {
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const clamped = Math.max(1, Math.floor(days));
  const endDate = isoDay(now);
  const startDate = isoDay(now - (clamped - 1) * DAY_MS);
  return { startDate, endDate };
}

/** Number of seconds between two YYYY-MM-DD strings (inclusive length). */
export function rangeLengthDays(range: UsageRange): number {
  const start = parseIsoDayOrNull(range.startDate);
  const end = parseIsoDayOrNull(range.endDate);
  if (start === null || end === null) return 0;
  return Math.round((end - start) / DAY_MS) + 1;
}

interface TableTotalsLike {
  totalTokens?: number | null;
  totalApiRequests?: number | null;
}

function buildTable(
  entries: ModelUsageEntry[],
  totalsSpend: number,
  totals: TableTotalsLike,
): string[] {
  const names = entries.map((e) => e.model);
  const nameWidth = Math.max("Model".length, ...names.map((n) => n.length));
  const spendWidth = Math.max(
    "Spend".length,
    ...entries.map((e) => (e.spend === null ? "-" : `$${e.spend.toFixed(4)}`).length),
    `$${totalsSpend.toFixed(4)}`.length,
  );
  const tokenWidth = Math.max(
    "Tokens".length,
    ...entries.map((e) => formatCompactTokens(e.totalTokens).length),
    formatCompactTokens(totals.totalTokens ?? null).length,
  );
  const reqWidth = Math.max(
    "Reqs".length,
    ...entries.map((e) => (e.apiRequests === null ? "-" : String(e.apiRequests)).length),
    String(totals.totalApiRequests ?? 0).length,
  );

  const renderRow = (model: string, spend: string, tokens: string, reqs: string): string =>
    `${model.padEnd(nameWidth)}  ${spend.padStart(spendWidth)}  ${tokens.padStart(tokenWidth)}  ${reqs.padStart(reqWidth)}`;

  const lines: string[] = [];
  const separator = "-".repeat(
    nameWidth + spendWidth + tokenWidth + reqWidth + 6,
  );
  lines.push(renderRow("Model", "Spend", "Tokens", "Reqs"));
  lines.push(separator);
  for (const entry of entries) {
    lines.push(
      renderRow(
        entry.model,
        entry.spend === null ? "-" : `$${entry.spend.toFixed(4)}`,
        formatCompactTokens(entry.totalTokens),
        entry.apiRequests === null ? "-" : String(entry.apiRequests),
      ),
    );
  }
  if (entries.length > 0) {
    lines.push(separator);
    lines.push(
      renderRow(
        "Total",
        `$${totalsSpend.toFixed(4)}`,
        formatCompactTokens(totals.totalTokens ?? null),
        String(totals.totalApiRequests ?? 0),
      ),
    );
  }
  return lines;
}

export interface FormatUsageTableOptions {
  /** Truncate the model rows to the top N by spend (totals row unaffected). */
  topN?: number;
}

/**
 * Renders the summary as an aligned fixed-width table with a totals row.
 * Token counts are compacted (k/M/B) to keep the table narrow.
 */
export function formatUsageTable(
  summary: ModelUsageSummary,
  options: FormatUsageTableOptions = {},
): string[] {
  const lines: string[] = [];
  const totalSpend = summary.totals.spend ?? 0;
  const header = `Usage ${summary.startDate} → ${summary.endDate} (${rangeLengthDays(summary)} days): $${totalSpend.toFixed(4)}`;
  lines.push(header);
  if (summary.models.length === 0) {
    lines.push("(no logged model usage in this range)");
    return lines;
  }
  const topN = typeof options.topN === "number" && options.topN > 0 ? options.topN : undefined;
  const rows = topN !== undefined ? summary.models.slice(0, topN) : summary.models;
  lines.push(...buildTable(rows, totalSpend, {
    totalTokens: summary.totals.totalTokens,
    totalApiRequests: summary.totals.apiRequests,
  }));
  if (topN !== undefined && summary.models.length > topN) {
    // The more-note sits just above the totals footer.
    lines.splice(lines.length - 1, 0, `(+${summary.models.length - topN} more models)`);
  }
  return lines;
}

export interface TopModelsBlockOptions {
  /** Label shown in the block title, e.g. "7d". */
  windowLabel: string;
  /** Pre-sorted (spend desc) rows; only the top 5 are rendered. */
  rows: Array<{ model: string; spend: number | null }>;
  /** Total tokens for the footer row; omit to hide the footer. */
  totalTokens?: number | null;
  /** Max model-name width before ellipsis truncation. */
  maxNameWidth?: number;
}

const TOP_MODELS_ROW_LIMIT = 5;

/**
 * Renders the compact boxed top-5 block shown in the TUI widgets below the
 * budget indicator. Single-width box drawing; rows are padded to a uniform
 * content width so the box stays square.
 */
export function buildTopModelsBlock(options: TopModelsBlockOptions): string[] {
  const maxNameWidth = options.maxNameWidth ?? 26;
  const rows = options.rows
    .slice(0, TOP_MODELS_ROW_LIMIT)
    .map((row) => ({
      model:
        row.model.length > maxNameWidth
          ? `${row.model.slice(0, maxNameWidth - 1)}…`
          : row.model,
      spend: row.spend,
    }));

  const title = ` Top models (${options.windowLabel}) `;
  const nameWidth = Math.max(
    ...(rows.length > 0 ? rows.map((r) => r.model.length) : [0]),
  );
  const spendWidth = 7; // "$999.99"
  const textWidth = nameWidth + 2 + spendWidth;
  const contentWidth = Math.max(title.length, textWidth) + 4;
  const border = (left: string, right: string, body: string): string =>
    `${left}${body.repeat(Math.max(0, contentWidth - 2))}${right}`;
  const content = (text: string): string =>
    `│ ${text.padEnd(contentWidth - 4)} │`;

  const lines: string[] = [];
  const borderBody = "─".repeat(Math.max(0, contentWidth - 2));
  lines.push(`┌${title.padEnd(contentWidth - 2, "─")}┐`);
  if (rows.length === 0) {
    lines.push(content("(no usage)"));
  } else {
    for (const row of rows) {
      lines.push(
        content(
          `${row.model.padEnd(nameWidth)}  ${`$${(row.spend ?? 0).toFixed(2)}`.padStart(spendWidth)}`,
        ),
      );
    }
  }
  lines.push(border("└", "┘", "─"));
  return lines;
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



export const TOP_MODELS_STATUS_KEY_PREFIX = "actsis-litellm:budget:top";

/**
 * Budget-style 8-cell gauge over a [0,100] percentage; same glyphs the
 * extension's budget status line renders (▰ filled / ▱ empty).
 */
export function usageGauge(percent: number, cells = 8): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * cells);
  return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

export interface TopModelsStatusEntry {
  key: string;
  text: string;
}

export function buildTopModelsStatusEntries(options: {
  windowLabel: string;
  rows: Array<{ model: string; spend: number | null }>;
  totalSpend?: number | null;
  keyPrefix?: string;
  maxRows?: number;
  maxNameWidth?: number;
}): TopModelsStatusEntry[] {
  const prefix = options.keyPrefix ?? TOP_MODELS_STATUS_KEY_PREFIX;
  const maxRows = options.maxRows ?? TOP_MODELS_ROW_LIMIT;
  const maxNameWidth = options.maxNameWidth ?? 26;

  const rows = options.rows.slice(0, maxRows).map((row) => ({
    model:
      row.model.length > maxNameWidth
        ? `${row.model.slice(0, maxNameWidth - 1)}…`
        : row.model,
    spend: row.spend,
  }));

  // Share percentages are relative to the window total: the sum of the rows
  // themselves when the caller has no authoritative total.
  const windowTotal =
    options.totalSpend !== null && options.totalSpend !== undefined
      ? options.totalSpend
      : rows.reduce((sum, r) => sum + (r.spend ?? 0), 0);

  const titleText =
    options.totalSpend !== null && options.totalSpend !== undefined
      ? `Top models (${options.windowLabel}) · $${options.totalSpend.toFixed(2)}`
      : `Top models (${options.windowLabel})`;

  const nameWidth = Math.max(0, ...rows.map((r) => r.model.length));
  const spendWidth = Math.max("$0.00".length, ...rows.map((r) => `$${(r.spend ?? 0).toFixed(2)}`.length));
  const pctWidth = 3; // right-aligned "60%" / " 2%"
  const GAUGE_CELLS = 8;
  const tableWidth = nameWidth + 1 + spendWidth + 1 + pctWidth + 1 + GAUGE_CELLS;

  const entries: TopModelsStatusEntry[] = [{ key: prefix, text: titleText }];
  // "=" rule under the title, like the /usage table separators. Keyed "top0"
  // so it sorts between the title ("top") and the rows ("top1".."top5").
  entries.push({ key: `${prefix}0`, text: "=".repeat(tableWidth) });
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const spendValue = row.spend ?? 0;
    const share = windowTotal > 0 ? Math.min(100, Math.max(0, (spendValue / windowTotal) * 100)) : 0;
    const text = `${row.model.padEnd(nameWidth)} ${`$${spendValue.toFixed(2)}`.padStart(spendWidth)} ${String(Math.round(share)).padStart(pctWidth)}% ${usageGauge(share)}`;
    entries.push({ key: `${prefix}${i + 1}`, text });
  }
  return entries;
}
