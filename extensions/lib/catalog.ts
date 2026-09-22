import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname } from "node:path";
import {
  fetchModels,
  fetchModelInfo,
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

const CACHE_SCHEMA_VERSION = 1;

interface CachedCatalogFile {
  version: number;
  fetchedAt: number;
  models: ProviderModelConfig[];
}

interface LiteLLMModelInfo {
  id?: string;
  input_cost_per_token?: number | null;
  output_cost_per_token?: number | null;
  cache_read_input_token_cost?: number | null;
  cache_creation_input_token_cost?: number | null;
  base_model?: unknown;
  max_tokens?: number | null;
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
  [key: string]: unknown;
}

function perMillion(value: number | null | undefined): number {
  if (value === undefined || value === null || !Number.isFinite(value)) return 0;
  return value * 1_000_000;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function buildInfoMap(infoBody: unknown): Map<string, LiteLLMModelInfo> {
  const map = new Map<string, LiteLLMModelInfo>();
  if (!Array.isArray(infoBody)) return map;
  for (const entry of infoBody) {
    if (typeof entry !== "object" || entry === null) continue;
    const info = entry as LiteLLMModelInfo;
    const id = typeof info.id === "string" ? info.id : "";
    if (!id) continue;
    if (!map.has(id)) {
      map.set(id, info);
    }
  }
  return map;
}

function infoToConfig(
  id: string,
  info: LiteLLMModelInfo | undefined,
): ProviderModelConfig {
  const contextWindow = positiveInt(info?.max_input_tokens) ?? 128_000;
  const maxTokens = positiveInt(info?.max_output_tokens) ?? 16_384;

  return {
    id,
    name: id,
    reasoning: true,
    input: ["text"],
    cost: {
      input: perMillion(info?.input_cost_per_token),
      output: perMillion(info?.output_cost_per_token),
      cacheRead: perMillion(info?.cache_read_input_token_cost),
      cacheWrite: perMillion(info?.cache_creation_input_token_cost),
    },
    contextWindow,
    maxTokens,
    compat: { supportsDeveloperRole: false },
  };
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

  let infoMap = new Map<string, LiteLLMModelInfo>();
  try {
    const infoResult = await fetchModelInfo(
      config.baseUrl,
      apiKey,
      config.requestTimeoutMs,
    );
    infoMap = buildInfoMap(infoResult.body);
  } catch {
    // Best-effort enrichment; proceed with default costs on failure.
  }

  function extractMode(
    entry: Record<string, unknown> | LiteLLMModelInfo | undefined,
  ): string | undefined {
    if (!entry || typeof entry !== "object") return undefined;
    const mode = entry.mode;
    if (typeof mode === "string" && mode) return mode;
    const litellmParams = entry.litellm_params;
    if (litellmParams && typeof litellmParams === "object") {
      const lpMode = (litellmParams as Record<string, unknown>).mode;
      if (typeof lpMode === "string" && lpMode) return lpMode;
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
