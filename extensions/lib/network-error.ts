/**
 * Builds a single-line diagnostic message for a failed fetch (or any thrown
 * network error). Node/undici wraps transport failures in an opaque
 * `TypeError: fetch failed` and hides the real reason (`ENOTFOUND`,
 * `ECONNREFUSED`, TLS trust errors, ...) in `err.cause`. This helper walks the
 * cause chain, extracts the deepest useful code/message, and appends a short
 * actionable hint for known failure classes. It is diagnostics-only: it never
 * retries, never changes control flow, and never mutates the error classes.
 */

interface CauseLink {
  name: string;
  code?: string;
  message: string;
}

const MAX_CHAIN_DEPTH = 5;

interface Hint {
  match: (link: CauseLink) => boolean;
  text: string;
}

// Order matters: only the first matching hint is appended.
const HINTS: Hint[] = [
  {
    match: (link) =>
      link.code !== undefined &&
      ([
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "CERT_SIGNATURE_FAILURE",
        "CERT_HAS_EXPIRED",
        "ERR_TLS_CERT_ALTNAME_INVALID",
      ].includes(link.code) || link.code.startsWith("ERR_SSL")),
    text:
      "the gateway's TLS certificate is not trusted by Node; install the issuing CA in the OS trust store and start Node with --use-system-ca (or point NODE_EXTRA_CA_CERTS at the CA bundle).",
  },
  {
    match: (link) =>
      link.code === "ENOTFOUND" || link.code === "EAI_AGAIN",
    text:
      "the gateway host could not be resolved; check the configured URL and DNS/VPN.",
  },
  {
    match: (link) => link.code === "ECONNREFUSED",
    text:
      "the connection was refused; check that the gateway is running and reachable.",
  },
  {
    match: (link) =>
      [
        "ETIMEDOUT",
        "ESOCKETTIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ].includes(link.code ?? "") || isTimeoutLink(link),
    text: "the request timed out before the gateway responded.",
  },
  {
    match: (link) => link.code === "ECONNRESET",
    text: "the connection was reset by the peer.",
  },
];

function isTimeoutLink(link: CauseLink): boolean {
  // DOMException timeouts carry name "TimeoutError" and the DOM code 23.
  // An explicit abort is a different code (20 / "AbortError") and must not
  // be reported as a timeout.
  if (link.name === "TimeoutError") return true;
  if (link.code === "23") return true;
  return false;
}

function readCode(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  // DOMException.code is a numeric DOM code (e.g. 23 = timeout).
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function fetchFailureMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }

  const links: CauseLink[] = [];
  const visited = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    if (!(current instanceof Error)) break;
    if (visited.has(current)) break; // cyclic cause chain
    visited.add(current);
    const rawCode = (current as { code?: unknown }).code;
    links.push({
      name: current.name,
      code: readCode(rawCode),
      message: current.message,
    });
    const cause = (current as { cause?: unknown }).cause;
    if (cause === null || cause === undefined || typeof cause !== "object") {
      break;
    }
    current = cause;
  }

  // No cause link and no code anywhere: preserve the original message
  // verbatim (existing tests assert it is not reformatted).
  const hasCause = links.length > 1;
  const hasCode = links.some((l) => l.code !== undefined);
  if (!hasCause && !hasCode) {
    return err.message;
  }

  // Deepest useful link: prefer the deepest link that carries a code,
  // falling back to the deepest link in the chain.
  let deepest = links[links.length - 1];
  for (let i = links.length - 1; i >= 0; i--) {
    if (links[i].code !== undefined) {
      deepest = links[i];
      break;
    }
  }

  const codeOrName = deepest.code ?? deepest.name;
  const hint = HINTS.find((h) => h.match(deepest));
  const hintSuffix = hint ? ` ${hint.text}` : "";
  return `${err.message} (${codeOrName}: ${deepest.message})${hintSuffix}`;
}