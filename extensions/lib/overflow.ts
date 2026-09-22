/**
 * LiteLLM/upstream context-window overflow phrase detector.
 *
 * Matches overflow phrases commonly surfaced through LiteLLM proxy error bodies
 * when the upstream rejects a request for exceeding the model's context window.
 * Intentionally excludes rate-limit / throttling phrases so those stay on pi's
 * normal retry-with-backoff path.
 */
export const LITELLM_OVERFLOW_PATTERN: RegExp = new RegExp(
  [
    "maximum context length",
    "context window",
    "context_length_exceeded",
    "input is too long",
    "prompt is too long",
    "too many input tokens",
    "requested tokens exceed",
    "reduce the length",
  ].join("|"),
  "i",
);

/**
 * Safe overflow phrase check.
 */
export function isOverflowErrorMessage(message: string | undefined): boolean {
  if (!message) return false;
  return LITELLM_OVERFLOW_PATTERN.test(message);
}

interface AssistantErrorMessage {
  role: string;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
}

/**
 * Normalize an assistant error message so pi recognizes it as a context
 * overflow and triggers auto-compaction recovery.
 *
 * Returns `null` when no rewrite should happen, preserving idempotence and
 * scoping the change to the registered provider.
 */
export function normalizeOverflowError(
  providerId: string | undefined,
  message: AssistantErrorMessage,
  activeModelProvider?: string,
): AssistantErrorMessage | null {
  if (!providerId) return null;
  if (message.role !== "assistant") return null;
  if (message.stopReason !== "error") return null;

  const matchesProvider =
    message.provider === providerId || activeModelProvider === providerId;
  if (!matchesProvider) return null;

  const errorMessage = message.errorMessage ?? "";
  if (!errorMessage) return null;
  if (!isOverflowErrorMessage(errorMessage)) return null;
  if (errorMessage.includes("context_length_exceeded")) return null;

  return {
    ...message,
    errorMessage: `context_length_exceeded: ${errorMessage}`,
  };
}
