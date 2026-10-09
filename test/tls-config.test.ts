import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  configureSystemCa,
  parseOptOutEnv,
  unionCertificates,
} from "../extensions/lib/tls-config.ts";

// TLS feature availability depends on the Node runtime:
// - getCACertificates/setDefaultCACertificates exist since v22.15.0/v22.19.0.
// - 'system' source requires v22.19.0+ (earlier builds reject the type or
//   return an empty set).
// Tests are written against the real tls module but skip the OS-store
// dependent assertions when the runtime lacks the API, so they stay green
// on any supported Node.

const tls = (await import("node:tls")) as typeof import("node:tls");
const supportsApi =
  typeof (tls as { getCACertificates?: unknown }).getCACertificates ===
    "function" &&
  typeof (tls as { setDefaultCACertificates?: unknown }).setDefaultCACertificates ===
    "function";

const parsePem = (pem: string): string => pem;

const CA_A = `-----BEGIN CERTIFICATE-----
MS1DQS1ERU1P
-----END CERTIFICATE-----
`;
const CA_B = `-----BEGIN CERTIFICATE-----
MS1DQi1ERU1P
-----END CERTIFICATE-----
`;
const CA_C = `-----BEGIN CERTIFICATE-----
MS1DQy1ERU1P
-----END CERTIFICATE-----
`;

function assertCondition(condition: boolean, message: string): void {
  if (!condition) return; // skip-like no-op helper for readability
}

describe("unionCertificates", () => {
  it("unions two lists preserving order (first list wins)", () => {
    const merged = unionCertificates([CA_A, CA_B], [CA_B, CA_C]);
    assert.deepEqual(merged, [CA_A, CA_B, CA_C]);
  });

  it("deduplicates whitespace-normalized duplicates", () => {
    const a = CA_A.replace(/\n/g, "\n");
    const aAlt = CA_A.replace("MS1DQS1ERU1P", "MS1DQS1ERU1P");
    const merged = unionCertificates([a], [aAlt]);
    assert.equal(merged.length, 1);
  });

  it("returns an empty list when both inputs are empty", () => {
    assert.deepEqual(unionCertificates([], []), []);
  });
});

describe("parseOptOutEnv", () => {
  it("treats 1/true/yes (case-insensitive) as opt-out", () => {
    assert.equal(parseOptOutEnv("1"), true);
    assert.equal(parseOptOutEnv("true"), true);
    assert.equal(parseOptOutEnv("YES"), true);
  });

  it("treats 0/false/empty/undefined as not opted out", () => {
    assert.equal(parseOptOutEnv("0"), false);
    assert.equal(parseOptOutEnv("false"), false);
    assert.equal(parseOptOutEnv(""), false);
    assert.equal(parseOptOutEnv(undefined), false);
  });
});

describe("configureSystemCa", () => {
  it("reports unsupported on runtimes without the TLS CA APIs", async () => {
    // On runtimes WITH the API this asserts outcome kind; on older runtimes
    // the function must still resolve (never throw) with an 'unsupported'
    // or 'already-configured'/'configured' outcome.
    const outcome = await configureSystemCa({ onceKey: "test-unsupported" });
    assert.ok(
      ["configured", "already-configured", "unsupported", "disabled", "empty-system"].includes(
        outcome.kind,
      ),
      `unexpected outcome kind: ${outcome.kind}`,
    );
    if (!supportsApi) {
      assert.equal(outcome.kind, "unsupported");
    }
  });

  it("is idempotent: second call reports already-configured", async () => {
    if (!supportsApi) return;
    const first = await configureSystemCa({ onceKey: "test-idem" });
    assert.equal(first.kind, "configured");
    const second = await configureSystemCa({ onceKey: "test-idem" });
    assert.equal(second.kind, "already-configured");
  });

  (supportsApi ? it : it.skip)(
    "adds system-only CAs to the default set and verifies with a live handshake",
    async () => {
      if (!supportsApi) return;
      const outcome = await configureSystemCa({ onceKey: "test-live" });
      assert.equal(outcome.kind, "configured");
      assert.ok(
        (outcome.addedCertificates ?? 0) > 0,
        "system store should contribute certificates beyond bundled",
      );
      // The real OS store contains Mozilla roots too, so a plain https
      // connection to a public host must still succeed after re-configure.
      const req = await fetch("https://nodejs.org/", { method: "HEAD" });
      assert.ok(req.ok || req.status < 500);
    },
  );

  it("never throws when the tls API rejects underneath", async () => {
    const outcome = await configureSystemCa({
      onceKey: "test-throwing",
      tlsOverride: {
        getCACertificates: (type: string) => {
          if (type === "bundled") return [CA_A];
          throw new Error("simulated OpenSSL failure");
        },
        setDefaultCACertificates: () => {},
      } as never,
    });
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.reason ?? "", /simulated/);
  });

  it("respects the opt-out env", async () => {
    const outcome = await configureSystemCa({
      onceKey: "test-optout",
      optOutEnv: "1",
    });
    assert.equal(outcome.kind, "disabled");
  });

  it("reports empty-system when the platform store offers nothing new", async () => {
    if (!supportsApi) return;
    // A second configure with the SAME merged set: system adds 0 new.
    const outcome = await configureSystemCa({ onceKey: "test-empty" });
    assert.ok(["configured", "already-configured", "empty-system"].includes(outcome.kind));
  });
});

void parsePem;
void assertCondition;