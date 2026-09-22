export interface LimitErrorInfo {
  kind: "budget_exceeded" | "throttling_error" | "rate_limit_other";
  limitType?: string;
  currentSpend?: number;
  maxBudget?: number;
  resetsAt?: number;
  raw: string;
}

interface LoosePayload {
  type?: string;
  message?: string;
  code?: string | number;
}

const REWRITTEN_MARKER = "[litellm]";

function extractFirstBalancedJson(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0) {
        start = i;
      }
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
      continue;
    }
  }
  return null;
}

function looksLikeRateLimit429(text: string): boolean {
  if (text.includes("429")) return true;
  const lower = text.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("throttl")
  );
}

function parseNumberish(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return undefined;
  return parsed;
}

function extractBudgetNumbers(
  message: string | undefined,
): Pick<LimitErrorInfo, "currentSpend" | "maxBudget"> {
  if (!message) return {};
  const currentMatch = message.match(/Current cost:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const maxMatch = message.match(/Max budget:\s*([0-9]+(?:\.[0-9]+)?)/i);
  return {
    currentSpend: parseNumberish(currentMatch?.[1]),
    maxBudget: parseNumberish(maxMatch?.[1]),
  };
}

function extractThrottleInfo(
  message: string | undefined,
): Pick<LimitErrorInfo, "limitType" | "resetsAt"> {
  if (!message) return {};
  const limitTypeMatch = message.match(/Limit type:\s*([^,.]+)/i);
  const resetMatch = message.match(
    /Limit resets at:\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*UTC/i,
  );
  const limitType = limitTypeMatch?.[1]?.trim();
  const resetText = resetMatch?.[1];
  let resetsAt: number | undefined;
  if (resetText) {
    const parsed = Date.parse(`${resetText} UTC`);
    if (!Number.isNaN(parsed)) resetsAt = parsed;
  }
  return {
    limitType: limitType || undefined,
    resetsAt,
  };
}

export function parseLimitError(
  message: string | undefined | null,
): LimitErrorInfo | null {
  if (!message) return null;
  const jsonText = extractFirstBalancedJson(message);
  if (!jsonText) {
    return looksLikeRateLimit429(message)
      ? { kind: "rate_limit_other", raw: message }
      : null;
  }

  let payload: LoosePayload;
  try {
    payload = JSON.parse(jsonText) as LoosePayload;
  } catch {
    return looksLikeRateLimit429(message)
      ? { kind: "rate_limit_other", raw: message }
      : null;
  }

  const kindByType = (payload.type ?? "").toLowerCase();
  if (kindByType === "budget_exceeded") {
    return {
      kind: "budget_exceeded",
      ...extractBudgetNumbers(payload.message),
      raw: message,
    };
  }
  if (kindByType === "throttling_error") {
    return {
      kind: "throttling_error",
      ...extractThrottleInfo(payload.message),
      raw: message,
    };
  }

  const is429 =
    String(payload.code ?? "").includes("429") || message.includes("429");
  if (!is429) return null;

  return { kind: "rate_limit_other", raw: message };
}

export function formatBudgetWarning(info: LimitErrorInfo): string {
  const spend = info.currentSpend ?? 0;
  const max = info.maxBudget ?? 0;
  return `Budget exceeded: $${spend.toFixed(2)} of $${max.toFixed(2)} used — top up the key budget or wait for the reset.`;
}

export function formatThrottleWarning(info: LimitErrorInfo): string {
  const limitType = info.limitType ? `(${info.limitType})` : "";
  const prefix = limitType ? `Rate limit reached ${limitType}` : "Rate limit reached";
  if (info.resetsAt) {
    const resetsLocal = new Date(info.resetsAt);
    const now = Date.now();
    const minutes = Math.max(0, Math.ceil((info.resetsAt - now) / 60_000));
    const time = resetsLocal.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${prefix}. Resets at ${time} (~${minutes} min). pi will retry automatically.`;
  }
  return `${prefix}. pi will retry automatically.`;
}

export function budgetUsagePercent(
  spend: number | undefined | null,
  maxBudget: number | undefined | null,
): number {
  const safeSpend = spend ?? 0;
  const safeMax = maxBudget ?? 0;
  if (safeMax <= 0) return 0;
  return (safeSpend / safeMax) * 100;
}

export function classify429(
  message: string | undefined | null,
): "none" | "budget_exceeded" | "throttling_error" | "rate_limit_other" {
  const info = parseLimitError(message);
  if (!info) return "none";
  return info.kind;
}

interface NormalizableMessage {
  role: string;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
}

function hasRewrittenMarker(errorMessage: string): boolean {
  return errorMessage.trimStart().startsWith(REWRITTEN_MARKER);
}

export function normalizeLimitError(
  providerId: string | undefined,
  message: NormalizableMessage,
  activeModelProvider?: string,
): NormalizableMessage | null {
  if (!providerId) return null;
  if (message.role !== "assistant") return null;
  if (message.stopReason !== "error") return null;

  const matchesProvider =
    message.provider === providerId || activeModelProvider === providerId;
  if (!matchesProvider) return null;

  const errorMessage = message.errorMessage ?? "";
  if (!errorMessage) return null;
  if (hasRewrittenMarker(errorMessage)) return null;

  const info = parseLimitError(errorMessage);
  if (!info || info.kind === "rate_limit_other") return null;

  if (info.kind === "budget_exceeded") {
    return {
      ...message,
      errorMessage: `${REWRITTEN_MARKER} ${formatBudgetWarning(info)}`,
    };
  }

  return {
    ...message,
    errorMessage: `${REWRITTEN_MARKER} ${errorMessage} | ${formatThrottleWarning(info)}`,
  };
}
