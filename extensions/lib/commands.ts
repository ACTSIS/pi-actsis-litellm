import os from "node:os";
import { formatLocalDateTime } from "./datetime.ts";
import path from "node:path";
import { readFile, writeFile, rm, access, mkdir } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AuthResult,
  ImageContent,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";
import type { OAuthCredential } from "@earendil-works/pi-ai/compat";
import { resolveConfig, type ActsisEnabledConfig } from "./config.ts";
import { fetchBudgetInfo, formatBudgetLine } from "./budget.ts";
import {
  applyModelAliases,
  fetchGatewayRequests,
  fetchModelUsage,
  formatUsageTable,
  isoDay,
  mapModelAliases,
  resolveDefaultUsageRange,
  type UsageRange,
} from "./usage.ts";
import { AuthError, CommandError, ConfigError } from "./errors.ts";
import {
  fetchImageGeneration,
  IMAGE_CUSTOM_TYPE,
  parseImageArgs,
  saveImageB64,
} from "./image.ts";
import { runDetachedImageJob, type ImageSessionStore } from "./image-tool.ts";
import { ImageJobRegistry } from "./image-jobs.ts";
import { revokeToken, type CliAuthDiscovery } from "./client.ts";
import { storedToDiscovery } from "./provider.ts";
import {
  fetchUsageSubs,
  formatUsageSubsLines,
} from "./usage-subs.ts";
import {
  loadCachedModels,
  loadCachedScope,
  catalogScopeLine,
  catalogScopeHint,
  computeCacheAge,
} from "./catalog.ts";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { LiteLLMExtensionState } from "../index.ts";

import { readStoredCredentialGatewayUrl, readStoredCredentialUserId } from "./gateway-url.ts";

const DEFAULT_PROVIDER_ID = "actsis-litellm";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface CommandDeps {
  getState: () => LiteLLMExtensionState;
  cachePath: string;
  authPath: string;
  prefsPath: string;
  requestTimeoutMs: number;
  /** Session render hook for /image (issue #47 S2); absent = notify fallback. */
  sendMessage?: (message: {
    customType: string;
    content: string | Array<TextContent | ImageContent>;
    display: boolean;
    details?: { filePath?: string };
  }) => void;
  /** Override for the image fallback directory (tests). */
  imageSaveDir?: string;
  /** Shared background-image job registry (T3/T5). */
  imageJobRegistry?: ImageJobRegistry;
  /** Shared session image store so /image --background updates "last" (T3/T4). */
  imageStore?: ImageSessionStore;
}

export function defaultCommandDeps(): CommandDeps {
  return {
    getState: () => ({}),
    cachePath: path.join(
      os.homedir(),
      ".pi",
      "agent",
      "actsis-litellm-models-cache.json",
    ),
    authPath: path.join(os.homedir(), ".pi", "agent", "auth.json"),
    prefsPath: path.join(
      os.homedir(),
      ".pi",
      "agent",
      "actsis-litellm-prefs.json",
    ),
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    imageJobRegistry: new ImageJobRegistry(),
  };
}

export function getProviderId(deps: CommandDeps): string {
  return deps.getState().providerId?.trim() || DEFAULT_PROVIDER_ID;
}

export async function resolveStatusConfig(
  providerId: string,
  authPath: string,
): Promise<ActsisEnabledConfig | null> {
  const storedUrl = await readStoredCredentialGatewayUrl(authPath, providerId);
  try {
    return await resolveConfig({
      env: process.env,
      fileLoader: async (filePath) => {
        try {
          const { readFile } = await import("node:fs/promises");
          const raw = await readFile(filePath, "utf8");
          return JSON.parse(raw);
        } catch {
          return null;
        }
      },
      storedUrl,
      prompt: async () => undefined,
    });
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}

function providerModels(
  registryModels: Model<Api>[],
  providerId: string,
): Model<Api>[] {
  return registryModels.filter((m) => m.provider === providerId);
}

function formatCacheAge(ageMs: number | null): string {
  if (ageMs === null) return "none";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes <= 0) return "just now";
  return `${minutes}m ago`;
}

function formatExpiry(credential: OAuthCredential | undefined): string {
  if (!credential) return "never";
  const expires =
    typeof credential.expires === "number" ? credential.expires : null;
  if (expires === null || !Number.isFinite(expires)) return "never";
  try {
    return formatLocalDateTime(expires) ?? "never";
  } catch {
    return "never";
  }
}

function extractOAuthCredential(result: AuthResult | undefined): OAuthCredential | undefined {
  if (!result) return undefined;
  const credential = (result as AuthResult & { credential?: unknown }).credential;
  if (
    credential &&
    typeof credential === "object" &&
    (credential as Record<string, unknown>).type === "oauth"
  ) {
    return credential as OAuthCredential;
  }
  return undefined;
}

function discoveryFromCredential(credential: OAuthCredential): CliAuthDiscovery | undefined {
  const tokenEndpoint =
    typeof credential.tokenEndpoint === "string" ? credential.tokenEndpoint : "";
  const revocationEndpoint =
    typeof credential.revocationEndpoint === "string"
      ? credential.revocationEndpoint
      : "";
  const resource =
    typeof credential.resource === "string" ? credential.resource : "";

  if (!tokenEndpoint || !revocationEndpoint || !resource) {
    return undefined;
  }

  return storedToDiscovery(credential);
}

/**
 * Extracts the bearer token for gateway REST calls from the pi auth
 * resolution (`getProviderAuth` -> AuthResult). The resolved key lives in
 * `auth.apiKey` and covers both OAuth and API-key credentials; the direct
 * credential fields are fallbacks for extension-compat shapes.
 */
export function extractUsableApiKey(authResult: unknown): string | null {
  if (!authResult || typeof authResult !== "object") return null;
  const record = authResult as Record<string, unknown>;

  const authObj = record.auth;
  if (authObj && typeof authObj === "object") {
    const apiKey = (authObj as { apiKey?: unknown }).apiKey;
    if (typeof apiKey === "string" && apiKey) return apiKey;
  }

  const oauthCredential = extractOAuthCredential(authResult as AuthResult);
  if (oauthCredential && typeof oauthCredential.access === "string" && oauthCredential.access) {
    return oauthCredential.access;
  }

  const rawAccess = record.access;
  if (typeof rawAccess === "string" && rawAccess) return rawAccess;

  return null;
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "error" | "warning" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

export function buildStatusHandler(deps: CommandDeps) {
  return async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const providerId = getProviderId(deps);

    try {
      const cfg = await resolveStatusConfig(providerId, deps.authPath);
      if (!cfg) {
        notify(
          ctx,
          "Gateway not configured. Run /login and select this provider to set it up.",
          "warning",
        );
        return;
      }

      const registered = ctx.modelRegistry
        .getRegisteredProviderIds()
        .includes(providerId);
      const authStatus = ctx.modelRegistry.getProviderAuthStatus(providerId);

      const authResult = await ctx.modelRegistry.getProviderAuth(providerId);
      const oauthCredential = extractOAuthCredential(authResult);

      let authLine: string;
      let sourceLine = "Credential source: unknown";

      if (oauthCredential) {
        const expiry = formatExpiry(oauthCredential);
        authLine = `Auth: oauth credential stored (expires ${expiry})`;
        const source = (authResult as AuthResult & { source?: string }).source;
        if (typeof source === "string" && source) {
          sourceLine = `Credential source: ${source}`;
        } else {
          sourceLine = "Credential source: stored";
        }
      } else if (authResult) {
        authLine = "Auth: credential stored";
        const source = (authResult as AuthResult & { source?: string }).source;
        if (typeof source === "string" && source) {
          sourceLine = `Credential source: ${source}`;
        }
      } else {
        authLine = "Auth: no credential";
      }

      const count = providerModels(ctx.modelRegistry.getAll(), providerId).length;
      const age = await computeCacheAge(deps.cachePath);
      const scope = await loadCachedScope(deps.cachePath);

      let budgetLine: string | null = null;
      try {
        // Same resolution as the budget widget: AuthResult.auth.apiKey covers
        // OAuth and API-key credentials; the oauth credential is a fallback.
        const apiKey = extractUsableApiKey(authResult);
        if (apiKey) {
          const info = await fetchBudgetInfo(
            cfg.baseUrl,
            apiKey,
            deps.requestTimeoutMs,
          );
          const line = formatBudgetLine(info, { color: true });
          budgetLine = line ? `Budget: ${line}` : null;
        }
      } catch (err) {
        if (err instanceof AuthError) {
          budgetLine = "Budget: Credential rejected — run /login again";
        } else {
          budgetLine = `Budget: unavailable (${err instanceof Error ? err.message : String(err)})`;
        }
      }

      const textLines = [
        `Provider: ${providerId} — ${registered ? "registered" : "not registered"}`,
        authLine,
        sourceLine,
        `Catalog: ${count} models for provider, cache age: ${formatCacheAge(age)}`,
        catalogScopeLine(scope),
        `Gateway: ${cfg.baseUrl}`,
      ];
      if (budgetLine) {
        textLines.push(budgetLine);
      }
      notify(ctx, textLines.join("\n"), "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(ctx, `actsis-litellm:status failed: ${message}`, "error");
    }
  };
}

export function buildModelsCommandHandler(deps: CommandDeps) {
  return async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const providerId = getProviderId(deps);

    if (ctx.hasUI) {
      ctx.ui.notify("Syncing model catalog from gateway...", "info");
    }

    try {
      const previous = await loadCachedModels(deps.cachePath);
      const previousIds = new Set(
        (previous ?? []).map((m: ProviderModelConfig) => m.id),
      );

      await ctx.modelRegistry.refresh({
        allowNetwork: true,
        providers: [providerId],
        force: true,
      });

      const current = providerModels(ctx.modelRegistry.getAll(), providerId);
      const currentIds = current.map((m) => m.id);
      const count = current.length;

      let message = `Model catalog synced: ${count} models available.`;

      if (previous !== null) {
        const added = currentIds.filter((id) => !previousIds.has(id)).length;
        const removed = previous.filter((m) => !currentIds.includes(m.id)).length;
        if (added > 0 || removed > 0) {
          message += ` (added ${added}, removed ${removed})`;
        }
      }

      // Issue #48: document which credential/scope the catalog was fetched
      // with, and hint at re-login when a team-constrained session can only
      // see oc/* models.
      const scope = await loadCachedScope(deps.cachePath);
      message += `\n${catalogScopeLine(scope)}`;
      const hint = catalogScopeHint(current, scope);
      if (hint) {
        message += `\n${hint}`;
      }

      notify(ctx, message, "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(ctx, `actsis-litellm:models failed: ${message}`, "error");
    }
  };
}

export function buildImageCommandHandler(deps: CommandDeps) {
  return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const providerId = getProviderId(deps);

    let parsed;
    try {
      parsed = parseImageArgs(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(ctx, `actsis-litellm:image: ${message}`, "warning");
      return;
    }

    try {
      const cfg = await resolveStatusConfig(providerId, deps.authPath);
      if (!cfg) {
        notify(
          ctx,
          "Gateway not configured. Run /login and select this provider to set it up.",
          "warning",
        );
        return;
      }
      // Same credential resolution as /usage and the budget widget (issue #47
      // S6): AuthResult.auth.apiKey covers API-key and OAuth shapes.
      const authResult = await ctx.modelRegistry.getProviderAuth(providerId);
      const apiKey = extractUsableApiKey(authResult);
      if (!apiKey) {
        notify(ctx, "No usable credential. Run /login first.", "warning");
        return;
      }

      if (parsed.background) {
        const registry = deps.imageJobRegistry;
        if (!registry) {
          notify(ctx, "Image job registry not configured.", "error");
          return;
        }
        const job = registry.create(parsed.model, parsed.size);
        notify(
          ctx,
          `Image render queued as ${job.id} (${parsed.model} ${parsed.size}). It will appear in the conversation when ready.`,
          "info",
        );
        const fetcher = () =>
          fetchImageGeneration(
            cfg.baseUrl,
            apiKey,
            { prompt: parsed.prompt, model: parsed.model, size: parsed.size },
            deps.requestTimeoutMs,
            job.controller.signal,
          );
        runDetachedImageJob(
          job,
          {
            sendMessage: (message) => deps.sendMessage?.(message),
            notify: (message, level = "info") => notify(ctx, message, level),
            setStatus: ctx.ui?.setStatus,
            store: deps.imageStore,
            imageSaveDir: deps.imageSaveDir,
            registry,
          },
          parsed.prompt,
          fetcher,
        ).catch(() => {
          // Delivery is handled inside the runner.
        });
        return;
      }

      // Generation is synchronous (512² ≈ 14 s, 1024² ≈ 48 s); show progress
      // instead of silence.
      notify(
        ctx,
        `Generating ${parsed.size} pixel-art image (about 15-60 s)...`,
        "info",
      );

      const result = await fetchImageGeneration(
        cfg.baseUrl,
        apiKey,
        { prompt: parsed.prompt, model: parsed.model, size: parsed.size },
        deps.requestTimeoutMs,
      );
      const data = result.images[0];
      const imagePart: ImageContent = { type: "image", data, mimeType: "image/png" };

      let filePath: string | undefined; // best-effort copy (R4-001)
      try {
        filePath = await saveImageB64(data, deps.imageSaveDir ?? os.tmpdir());
      } catch {
        notify(ctx, "File copy failed; image is still rendered", "warning");
      }
      deps.imageStore?.set({ data, mimeType: "image/png", filePath });
      const content: Array<TextContent | ImageContent> = [
        { type: "text", text: `/image "${parsed.prompt}" — ${result.model} ${result.size}` },
        imagePart,
      ];

      if (deps.sendMessage) {
        // Displayed custom message: shows in the transcript without
        // triggering a model turn (issue #47 S2/S5). details.filePath lets
        // the renderer print the fallback path on text-only terminals.
        deps.sendMessage({
          customType: IMAGE_CUSTOM_TYPE,
          content,
          display: true,
          details: { filePath },
        });
        notify(ctx, filePath ? `Saved copy: ${filePath}` : "File copy failed (image rendered in transcript)", "warning");
      } else {
        notify(ctx, `Image saved to ${filePath}`, "info");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(ctx, `actsis-litellm:image failed: ${message}`, "error");
    }
  };
}

export function buildCancelImageHandler(deps: CommandDeps) {
  return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const target = args.trim();
    const registry = deps.imageJobRegistry;
    if (!registry) {
      notify(ctx, "Image job registry not configured.", "error");
      return;
    }
    if (!target || target === "all") {
      if (target === "all") {
        const ids = registry.cancelAll();
        if (ids.length === 0) {
          notify(ctx, "No image renders in flight.", "info");
          return;
        }
        notify(
          ctx,
          `Aborted image renders: ${ids.join(", ")}. The render may keep running on the gateway GPU.`,
          "info",
        );
        return;
      }
      notify(ctx, "Usage: /actsis-litellm:cancel-image \u003cid|all\u003e", "warning");
      return;
    }
    const job = registry.cancel(target);
    if (!job) {
      notify(ctx, `No active image render with id "${target}".`, "warning");
      return;
    }
    notify(
      ctx,
      `Aborted image render ${job.id} (${job.model} ${job.size}). The render may keep running on the gateway GPU.`,
      "info",
    );
  };
}

async function clearAuthJson(authPath: string, providerId: string): Promise<void> {
  try {
    await access(authPath);
  } catch {
    return;
  }

  let parsed: unknown;
  try {
    const raw = await readFile(authPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  if (typeof parsed !== "object" || parsed === null) return;
  const record = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, providerId)) return;

  delete record[providerId];

  await writeFile(authPath, JSON.stringify(record, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function clearCache(cachePath: string): Promise<void> {
  try {
    await rm(cachePath, { force: true });
  } catch {
    // Best-effort; ignore cleanup failures.
  }
}

export function buildLogoutHandler(deps: CommandDeps) {
  return async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const providerId = getProviderId(deps);

    try {
      const authResult = await ctx.modelRegistry.getProviderAuth(providerId);
      const credential = extractOAuthCredential(authResult);

      if (!credential) {
        notify(ctx, `No stored credentials for ${providerId}.`, "warning");
        return;
      }

      const refresh =
        typeof credential.refresh === "string" ? credential.refresh : "";
      const clientId =
        typeof credential.clientId === "string" ? credential.clientId : "";
      const discovery = discoveryFromCredential(credential);

      if (refresh && discovery) {
        try {
          await revokeToken(
            discovery,
            { token: refresh, clientId },
            deps.requestTimeoutMs,
          );
        } catch (err) {
          if (err instanceof Error && err.message.includes("fetch")) {
            notify(
              ctx,
              "Could not reach gateway to revoke the refresh token (it will still expire on its own).",
              "warning",
            );
          }
          // Continue clearing local state even if revocation fails.
        }
      }

      await clearAuthJson(deps.authPath, providerId);
      await clearCache(deps.cachePath);

      notify(
        ctx,
        "Logged out. Refresh token revoked on gateway (or expired locally). Catalog cache cleared.",
        "info",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(ctx, `actsis-litellm:logout failed: ${message}`, "error");
    }
  };
}

const RANGE_ARG_RE = /^(\d{4}-\d{2}-\d{2})\s+(?:to|→|\.\.|,)\s+(\d{4}-\d{2}-\d{2})$/;

// --- Top-widget preference (extension-owned prefs file) ---

export interface Prefs {
  topModelsWidget: boolean;
}

export function defaultsPrefs(): Prefs {
  return { topModelsWidget: true };
}

export async function readPrefs(prefsPath: string): Promise<Prefs> {
  try {
    const raw = await readFile(prefsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      topModelsWidget:
        typeof parsed.topModelsWidget === "boolean"
          ? parsed.topModelsWidget
          : defaultsPrefs().topModelsWidget,
    };
  } catch {
    // Missing or corrupt prefs fall back to defaults; never fail a command
    // because of a preference file.
    return defaultsPrefs();
  }
}

export async function readTopModelsWidgetEnabled(prefsPath: string): Promise<boolean> {
  return (await readPrefs(prefsPath)).topModelsWidget;
}

export async function updateTopModelsWidgetEnabled(
  prefsPath: string,
  enabled: boolean,
): Promise<void> {
  const current = await readPrefs(prefsPath);
  try {
    await mkdir(path.dirname(prefsPath), { recursive: true });
    await writeFile(
      prefsPath,
      `${JSON.stringify({ ...current, topModelsWidget: enabled }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Preference persistence is best-effort: an unwritable HOME still allows
    // a session-scoped toggle.
  }
}

export interface TopToggleResult {
  state: "on" | "off";
  changed: boolean;
}

export function parseTopPrefArg(
  args: string,
  current: boolean,
): TopToggleResult | { error: string } {
  const trimmed = (args ?? "").trim().toLowerCase();
  if (trimmed === "") {
    const next = !current;
    return { state: next ? "on" : "off", changed: true };
  }
  if (trimmed === "on" || trimmed === "off") {
    const next = trimmed === "on";
    return { state: next ? "on" : "off", changed: next !== current };
  }
  return { error: "expected nothing (toggle), `on`, or `off`" };
}

export function buildTopHandler(deps: CommandDeps) {
  return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    try {
      const current = await readTopModelsWidgetEnabled(deps.prefsPath);
      const parsed = parseTopPrefArg(args, current);
      if ("error" in parsed) {
        notify(ctx, `actsis-litellm:top: ${parsed.error}`, "warning");
        return;
      }
      if (parsed.changed) {
        await updateTopModelsWidgetEnabled(deps.prefsPath, parsed.state === "on");
      }
      notify(ctx, `Top-5 widget: ${parsed.state}${parsed.changed ? " (saved)" : " (already)"}`, "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(ctx, `actsis-litellm:top failed: ${message}`, "error");
    }
  };
}

/**
 * Parses the /usage argument. Supported forms:
 *   (empty)            -> default range (last 30 days inclusive)
 *   7 | 14 | 30        -> last N days inclusive (clamped to >= 1)
 *   2025-03-01 .. 2025-03-31 (separators: to, .., comma, arrow)
 */
export function parseUsageRangeArg(
  args: string,
  nowMs?: number,
): { range: UsageRange; label: string } | { error: string } {
  const trimmed = (args ?? "").trim();
  const defaults = resolveDefaultUsageRange(nowMs ?? Date.now());
  if (!trimmed) {
    return { range: defaults, label: "last 30 days" };
  }
  if (/^\d+$/.test(trimmed)) {
    const days = Math.max(1, parseInt(trimmed, 10));
    const end = isoDay(nowMs ?? Date.now());
    const start = isoDay(
      (nowMs ?? Date.now()) - (days - 1) * 24 * 60 * 60 * 1000,
    );
    return { range: { startDate: start, endDate: end }, label: `last ${days} day${days === 1 ? "" : "s"}` };
  }
  const rangeMatch = trimmed.match(RANGE_ARG_RE);
  if (rangeMatch) {
    const [, start, end] = rangeMatch;
    if (Date.parse(`${start}T00:00:00Z`) > Date.parse(`${end}T00:00:00Z`)) {
      return { error: `start date ${start} is after end date ${end}` };
    }
    return { range: { startDate: start, endDate: end }, label: `${start} → ${end}` };
  }
  return {
    error:
      "expected nothing (last 30 days), a day count like `14`, or a range like `2025-03-01 .. 2025-03-31`",
  };
}

export function buildUsageHandler(deps: CommandDeps) {
  return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const providerId = getProviderId(deps);
    const parsed = parseUsageRangeArg(args);
    if ("error" in parsed) {
      notify(ctx, `actsis-litellm:usage: ${parsed.error}`, "warning");
      return;
    }

    try {
      const cfg = await resolveStatusConfig(providerId, deps.authPath);
      if (!cfg) {
        notify(
          ctx,
          "Gateway not configured. Run /login and select this provider to set it up.",
          "warning",
        );
        return;
      }
      const authResult = await ctx.modelRegistry.getProviderAuth(providerId);
      const apiKey = extractUsableApiKey(authResult);
      if (!apiKey) {
        notify(ctx, "No usable credential. Run /login first.", "warning");
        return;
      }
      const userId = (await readStoredCredentialUserId(deps.authPath, providerId)) ?? undefined;
      const summary = await fetchModelUsage(
        cfg.baseUrl,
        apiKey,
        deps.requestTimeoutMs,
        parsed.range,
        { userId },
      );
      // Present public model names (what the user sees in /model and the
      // gateway UI) instead of LiteLLM's internal deployment names from the
      // spend logs. Keys that match no public id (non-chat models absent
      // from the chat catalog) stay as-is.
      const publicIds = providerModels(ctx.modelRegistry.getAll(), providerId)
        .map((m) => m.id);
      const display = applyModelAliases(
        summary,
        mapModelAliases(
          summary.models.map((m) => m.model),
          publicIds,
        ),
      );
      const lines = [`Usage (${parsed.label}):`, ...formatUsageTable(display)];
      // The dashboard's Total Requests card counts gateway-answered requests
      // (includes non-spend-logged traffic, e.g. audio); surface it as a
      // best-effort footnote so numbers reconcile with the dashboard.
      try {
        const gateway = await fetchGatewayRequests(
          cfg.baseUrl,
          apiKey,
          deps.requestTimeoutMs,
          parsed.range,
          { userId },
        );
        if (gateway) {
          lines.push(
            `Gateway requests: ${gateway.total.toLocaleString("en-US")} (successful ${gateway.successful.toLocaleString("en-US")} · failed ${gateway.failed.toLocaleString("en-US")}) — includes non-logged traffic`,
          );
        }
      } catch {
        // Footnote is best-effort.
      }
      notify(ctx, lines.join("\n"), "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(ctx, `actsis-litellm:usage failed: ${message}`, "error");
    }
  };
}

export function buildUsageSubsHandler(deps: CommandDeps) {
  return async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const providerId = getProviderId(deps);

    try {
      const cfg = await resolveStatusConfig(providerId, deps.authPath);
      if (!cfg) {
        notify(
          ctx,
          "Gateway not configured. Run /login and select this provider to set it up.",
          "warning",
        );
        return;
      }

      const authResult = await ctx.modelRegistry.getProviderAuth(providerId);
      const apiKey = extractUsableApiKey(authResult);
      if (!apiKey) {
        notify(ctx, "No usable credential. Run /login first.", "warning");
        return;
      }

      const data = await fetchUsageSubs(
        cfg.baseUrl,
        apiKey,
        deps.requestTimeoutMs,
      );
      notify(ctx, formatUsageSubsLines(data, { color: true }).join("\n"), "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(ctx, `actsis-litellm:usage-subs failed: ${message}`, "error");
    }
  };
}
