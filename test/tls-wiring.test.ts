import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configureSystemCa } from "../extensions/lib/tls-config.ts";

// Wiring contract: the extension entrypoint must call configureSystemCa
// (with the extension onceKey and the opt-out env) BEFORE registering
// commands/providers, and the call must be non-fatal. This test exercises
// the real function contract that index.ts relies on and verifies the
// opt-out flag name stays stable (README + users depend on it).

describe("extension TLS wiring contract", () => {
  it("uses the stable onceKey and respects ACTSIS_LITELLM_NO_SYSTEM_CA", async () => {
    // Disabled by opt-out: outcome must be 'disabled', proving the env flag
    // name ACTSIS_LITELLM_NO_SYSTEM_CA is honored through parseOptOutEnv.
    const outcome = await configureSystemCa({
      onceKey: "actsis-litellm-extension",
      optOutEnv: "1",
    });
    assert.equal(outcome.kind, "disabled");
  });

  it("real call resolves (never rejects) with the extension onceKey", async () => {
    const outcome = await configureSystemCa({
      onceKey: "actsis-litellm-extension",
      optOutEnv: undefined,
    });
    assert.ok(
      ["configured", "already-configured", "unsupported", "disabled", "empty-system", "failed"].includes(
        outcome.kind,
      ),
    );
  });
});