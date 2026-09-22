import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname } from "node:path";
import {
  fetchModels,
  fetchModelInfo,
  fetchModelInfoV2,
  type ModelsResponse,
} from "./client.ts";
import { CatalogError } from "./errors.ts";
import type { ActsisEnabledConfig } from "./config.ts";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const CHAT_MODES = new Set(["chat", "completion"]);
const NON_CHAT_MODES = new Set([
  "embedding",
  "audio_speech",
  "audio_transcription",
  "image_generation",
  "image_edit",
  "video_generation",
  "rerank",
  "moderations",
  "realtime",
]);

// Conservative name heuristic for when no mode metadata is available.
// NOTE: bare 'audio'/'speech' tokens are intentionally NOT in this list
// because they are too risky for legitimate chat models (e.g. gpt-4o-audio-preview).
// Gateways that return per-model mode metadata will still filter non-chat audio
// models via the metadata path.
const NON_CHAT_ID_RE =
  /(^|[-_/.])(embed|embedding|embeddings|whisper|tts|transcription|transcrib|rerank|reranker|moderation|moderations|speech|diarize|dall-e|dalle|imagegen|stable-diffusion)([-_/.]|$)/i;

export function isChatModelId(
  id: string,
  metadataMode?: string | null,
): boolean {
  if (typeof metadataMode === "string" && metadataMode.length > 0) {
    const mode = metadataMode.toLowerCase();
    if (CHAT_MODES.has(mode)) return true;
    if (NON_CHAT_MODES.has(mode)) return false;
  }
  return !NON_CHAT_ID_RE.test(id);
}

// v2: enrichment is keyed by model_name (was model_info.id) and maps richer
// model_info fields; bump invalidates caches populated with fallback values.
const CACHE_SCHEMA_VERSION = 2;

interface CachedCatalogFile {
  version: number;
  fetchedAt: number;
  models: ProviderModelConfig[];
}

/**
 * One entry from /model/info or /v2/model/info. The public model name lives at
 * the top level (`model_name`); `model_info.id` is an opaque deployment hash
 * and must never be used to match against /v1/models ids.
 */
type LiteLLMInfoEntry = Record<string, unknown>;

type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;
type CostTiers = NonNullable<NonNullable<ProviderModelConfig["cost"]>["tiers"]>;

const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const TIER_SUFFIXES: Array<[number, string]> = [
  [128_000, "128k"],
  [200_000, "200k"],
  [272_000, "272k"],
  [512_000, "512k"],
];

const V2_PAGE_SIZE = 100;
const V2_MAX_PAGES = 5;

function perMillion(value: unknown): number {
  const n = finiteNumber(value);
  return n === undefined ? 0 : n * 1_000_000;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function infoMapKey(entry: Record<string, unknown>): string {
  const modelName = entry.model_name;
  if (typeof modelName === "string" && modelName) return modelName;
  const modelInfo = entry.model_info;
  if (modelInfo && typeof modelInfo === "object") {
    const key = (modelInfo as Record<string, unknown>).key;
    if (typeof key === "string" && key) return key;
  }
  return "";
}

function buildInfoMap(
  infoBody: unknown,
  map: Map<string, LiteLLMInfoEntry> = new Map(),
): Map<string, LiteLLMInfoEntry> {
  const entries = Array.isArray(infoBody)
    ? infoBody
    : infoBody !== null &&
        typeof infoBody === "object" &&
        Array.isArray((infoBody as Record<string, unknown>).data)
      ? ((infoBody as Record<string, unknown>).data as unknown[])
      : null;
  if (!entries) return map;
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const key = infoMapKey(entry);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, entry);
    }
  }
  return map;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined;
  return value;
}

/**
 * Merge a /model/info entry into a flat field view: model_info fields win,
 * top-level fields are the fallback (for a future shape that hoists them).
 */
function resolveModelInfo(
  entry: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!entry) return {};
  const modelInfo = entry.model_info;
  if (modelInfo && typeof modelInfo === "object" && !Array.isArray(modelInfo)) {
    return { ...entry, ...(modelInfo as Record<string, unknown>) };
  }
  return entry;
}

function buildCostTiers(info: Record<string, unknown>): CostTiers {
  const cacheRead = perMillion(info.cache_read_input_token_cost);
  const cacheWrite = perMillion(info.cache_creation_input_token_cost);
  const tiers: CostTiers = [];
  for (const [inputTokensAbove, suffix] of TIER_SUFFIXES) {
    const input = finiteNumber(info[`input_cost_per_token_above_${suffix}_tokens`]);
    const output = finiteNumber(info[`output_cost_per_token_above_${suffix}_tokens`]);
    if (input === undefined && output === undefined) continue;
    tiers.push({
      input: input !== undefined ? input * 1_000_000 : 0,
      output: output !== undefined ? output * 1_000_000 : 0,
      cacheRead,
      cacheWrite,
      inputTokensAbove,
    });
  }
  tiers.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
  return tiers;
}

function buildThinkingLevelMap(levels: unknown): ThinkingLevelMap | undefined {
  if (!Array.isArray(levels)) return undefined;
  const supported = new Set<string>();
  for (const level of levels) {
    if (typeof level === "string" && level) supported.add(level);
  }
  if (supported.size === 0) return undefined;
  const map: Record<string, string | null> = {};
  for (const level of PI_THINKING_LEVELS) {
    if (level === "off") {
      map.off = supported.has("none") ? "none" : null;
    } else {
      map[level] = supported.has(level) ? level : null;
    }
  }
  return map as ThinkingLevelMap;
}

function infoToConfig(
  id: string,
  entry: Record<string, unknown> | undefined,
): ProviderModelConfig {
  const info = resolveModelInfo(entry);
  const contextWindow = positiveInt(info.max_input_tokens) ?? 128_000;
  const maxTokens =
    positiveInt(info.max_output_tokens) ?? positiveInt(info.max_tokens) ?? 16_384;

  const input: ("text" | "image")[] = ["text"];
  if (info.supports_vision === true) input.push("image");

  const tiers = buildCostTiers(info);
  const config: ProviderModelConfig = {
    id,
    name: id,
    reasoning: true,
    input,
    cost: {
      input: perMillion(info.input_cost_per_token),
      output: perMillion(info.output_cost_per_token),
      cacheRead: perMillion(info.cache_read_input_token_cost),
      cacheWrite: perMillion(info.cache_creation_input_token_cost),
      ...(tiers.length > 0 ? { tiers } : {}),
    },
    contextWindow,
    maxTokens,
    compat: { supportsDeveloperRole: false },
  };

  const thinkingLevelMap = buildThinkingLevelMap(info.reasoning_effort_levels);
  if (thinkingLevelMap) config.thinkingLevelMap = thinkingLevelMap;

  return config;
}

export async function fetchCatalogModels(
  config: ActsisEnabledConfig,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ProviderModelConfig[]> {
  const modelsResult: ModelsResponse = await fetchModels(
    config.baseUrl,
    apiKey,
    config.requestTimeoutMs,
  );

  const body = modelsResult.body as {
    data?: Array<{ id?: string; [key: string]: unknown }>;
  };

  if (!Array.isArray(body?.data)) {
    throw new CatalogError(
      "Gateway /v1/models response did not contain a data array",
    );
  }

  const ids: string[] = [];
  for (const entry of body.data) {
    if (typeof entry === "object" && entry !== null) {
      const id = typeof entry.id === "string" ? entry.id : "";
      if (id) ids.push(id);
    }
  }

  let infoMap = new Map<string, LiteLLMInfoEntry>();
  try {
    const infoResult = await fetchModelInfo(
      config.baseUrl,
      apiKey,
      config.requestTimeoutMs,
    );
    infoMap = buildInfoMap(infoResult.body);
  } catch {
    // Fall through to the paginated v2 endpoint.
  }

  if (infoMap.size === 0) {
    try {
      infoMap = await fetchInfoMapV2(config, apiKey);
    } catch {
      // Best-effort enrichment; proceed with default costs on failure.
    }
  }

  function extractMode(
    entry: Record<string, unknown> | undefined,
  ): string | undefined {
    if (!entry || typeof entry !== "object") return undefined;
    const mode = entry.mode;
    if (typeof mode === "string" && mode) return mode;
    const litellmParams = entry.litellm_params;
    if (litellmParams && typeof litellmParams === "object") {
      const lpMode = (litellmParams as Record<string, unknown>).mode;
      if (typeof lpMode === "string" && lpMode) return lpMode;
    }
    const modelInfo = entry.model_info;
    if (modelInfo && typeof modelInfo === "object") {
      const miMode = (modelInfo as Record<string, unknown>).mode;
      if (typeof miMode === "string" && miMode) return miMode;
    }
    const metadata = entry.metadata;
    if (metadata && typeof metadata === "object") {
      const mdMode = (metadata as Record<string, unknown>).mode;
      if (typeof mdMode === "string" && mdMode) return mdMode;
    }
    return undefined;
  }

  const seen = new Set<string>();
  const models: ProviderModelConfig[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (seen.has(id)) continue;
    const v1Entry = body.data[i];
    const infoEntry = infoMap.get(id);
    const mode = extractMode(v1Entry) ?? extractMode(infoEntry);
    if (!isChatModelId(id, mode)) continue;
    seen.add(id);
    models.push(infoToConfig(id, infoEntry));
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

async function fetchInfoMapV2(
  config: ActsisEnabledConfig,
  apiKey: string,
): Promise<Map<string, LiteLLMInfoEntry>> {
  const map = new Map<string, LiteLLMInfoEntry>();
  const first = await fetchModelInfoV2(
    config.baseUrl,
    apiKey,
    config.requestTimeoutMs,
    1,
    V2_PAGE_SIZE,
  );
  const firstBody = first.body as { data?: unknown; total_pages?: unknown } | null;
  if (!firstBody || typeof firstBody !== "object") return map;
  buildInfoMap(firstBody.data, map);

  const totalPages = positiveInt(firstBody.total_pages) ?? 1;
  const lastPage = Math.min(totalPages, V2_MAX_PAGES);
  for (let page = 2; page <= lastPage; page++) {
    const result = await fetchModelInfoV2(
      config.baseUrl,
      apiKey,
      config.requestTimeoutMs,
      page,
      V2_PAGE_SIZE,
    );
    const body = result.body as { data?: unknown } | null;
    if (body && typeof body === "object") {
      buildInfoMap(body.data, map);
    }
  }
  return map;
}

export async function loadCachedModels(
  cachePath: string,
): Promise<ProviderModelConfig[] | null> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const file = parsed as CachedCatalogFile;
    if (file.version !== CACHE_SCHEMA_VERSION) return null;
    if (!Array.isArray(file.models)) return null;
    if (!Number.isFinite(file.fetchedAt)) return null;
    return file.models;
  } catch {
    return null;
  }
}

export async function saveCachedModels(
  cachePath: string,
  models: ProviderModelConfig[],
): Promise<void> {
  const file: CachedCatalogFile = {
    version: CACHE_SCHEMA_VERSION,
    fetchedAt: Date.now(),
    models,
  };

  await mkdir(dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.tmp.${process.pid}`;
  try {
    await writeFile(tmpPath, JSON.stringify(file, null, 2), "utf8");
    await access(dirname(cachePath));
    // Atomic-ish rename on POSIX; on Windows rename may not overwrite.
    await import("node:fs").then(({ rename }) =>
      new Promise<void>((resolve, reject) => {
        rename(tmpPath, cachePath, (err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    );
  } catch (err) {
    // Clean up the temp file if the rename failed.
    try {
      await import("node:fs/promises").then(({ rm }) => rm(tmpPath));
    } catch {
      // Ignore cleanup failures.
    }
    throw err;
  }
}

export async function computeCacheAge(
  cachePath: string,
): Promise<number | null> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const file = parsed as CachedCatalogFile;
    if (file.version !== CACHE_SCHEMA_VERSION) return null;
    if (!Number.isFinite(file.fetchedAt)) return null;
    return Math.max(0, Date.now() - file.fetchedAt);
  } catch {
    return null;
  }
}
