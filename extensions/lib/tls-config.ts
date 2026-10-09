/**
 * Frictionless TLS bootstrap for enterprise gateways whose HTTPS certificates
 * are issued by a private (internal) CA installed in the OS trust store.
 *
 * Node.js ships a fixed snapshot of Mozilla's root CAs and ignores the OS
 * certificate store unless explicitly told otherwise, so a gateway signed by
 * an internal CA fails TLS validation inside pi's login and chat flows even
 * though browsers and the OS itself trust it ("certificate installed on
 * Windows" is not enough for Node).
 *
 * This module unions Node's bundled CAs with whatever the OS system store
 * exposes and installs the merged set as the process-wide default. It is
 * strictly additive (bundled CAs always stay), idempotent per session,
 * fail-open (any TLS API failure leaves the process untouched), and can be
 * disabled with ACTSIS_LITELLM_NO_SYSTEM_CA=1.
 *
 * Runtime requirements: node:tls getCACertificates + setDefaultCACertificates
 * (v22.19.0+ for the 'system' source). On older runtimes this reports
 * `unsupported` and the extension keeps working exactly as before.
 */

export type SystemCaOutcomeKind =
  | "configured"
  | "already-configured"
  | "unsupported"
  | "disabled"
  | "empty-system"
  | "failed";

export interface SystemCaOutcome {
  kind: SystemCaOutcomeKind;
  /** Certificates added by the system store on top of the bundled set. */
  addedCertificates?: number;
  /** populated for kind="failed": why the TLS API call did not run. */
  reason?: string;
}

interface MinimalTls {
  getCACertificates(type: "system" | "bundled" | "extra" | "default"): string[];
  setDefaultCACertificates(certs: string[]): void;
}

export interface ConfigureSystemCaOptions {
  /** Idempotency key; repeats report already-configured without re-merging. */
  onceKey?: string;
  /** Treated as opt-out when "1"/"true"/"yes" (case-insensitive). */
  optOutEnv?: string;
  /** Test hook: overrides the real node:tls module. */
  tlsOverride?: MinimalTls;
}

const ONE_SHOT_ATTEMPTS = new Set<string>();

/** Normalizes a PEM block for comparison ( collapses whitespace variants). */
function normalizePem(cert: string): string {
  return cert.replace(/\r/g, "").replace(/\s+/g, "\n").trim();
}

export function parseOptOutEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

export function unionCertificates(
  primary: string[],
  secondary: string[],
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const cert of [...primary, ...secondary]) {
    const key = normalizePem(cert);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(cert);
  }
  return merged;
}

async function loadTls(): Promise<MinimalTls> {
  const mod = (await import("node:tls")) as unknown as {
    getCACertificates?: MinimalTls["getCACertificates"];
    setDefaultCACertificates?: MinimalTls["setDefaultCACertificates"];
  };
  if (typeof mod.getCACertificates !== "function" || typeof mod.setDefaultCACertificates !== "function") {
    throw new Error("runtime lacks node:tls CA management APIs");
  }
  return mod as MinimalTls;
}

export async function configureSystemCa(
  options: ConfigureSystemCaOptions = {},
): Promise<SystemCaOutcome> {
  const onceKey = options.onceKey ?? "default";
  if (parseOptOutEnv(options.optOutEnv)) {
    return { kind: "disabled" };
  }
  if (ONE_SHOT_ATTEMPTS.has(onceKey)) {
    return { kind: "already-configured" };
  }
  ONE_SHOT_ATTEMPTS.add(onceKey);

  let tlsApi: MinimalTls;
  try {
    tlsApi = options.tlsOverride ?? (await loadTls());
  } catch (err) {
    return {
      kind: "unsupported",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const bundled = tlsApi.getCACertificates("bundled");
    let system: string[];
    try {
      system = tlsApi.getCACertificates("system");
    } catch (err) {
      // The API exists but the platform store read failed (OpenSSL/OS error):
      // this is a runtime failure, not an unsupported runtime. Fail open.
      return {
        kind: "failed",
        reason:
          err instanceof Error
            ? `node:tls rejected the "system" source: ${err.message}`
            : String(err),
      };
    }

    const bundledSet = normalizedSet(bundled);
    const systemSet = normalizedSet(system);
    const added = [...systemSet].filter((c) => !bundledSet.has(c));
    if (added.length === 0) {
      return { kind: "empty-system", addedCertificates: 0 };
    }

    const merged = unionCertificates(bundled, system);
    tlsApi.setDefaultCACertificates(merged);
    return { kind: "configured", addedCertificates: added.length };
  } catch (err) {
    return {
      kind: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// Comparison helper: normalized PEM identity set (bounded, few hundred CA).
function normalizedSet(certs: string[]): Set<string> {
  const set = new Set<string>();
  for (const cert of certs) set.add(normalizePem(cert));
  return set;
}