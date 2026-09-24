import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchFailureMessage } from "../extensions/lib/network-error.ts";
import {
  fetchCliAuthDiscovery,
  fetchModels,
} from "../extensions/lib/client.ts";
import { CatalogError, DiscoveryError } from "../extensions/lib/errors.ts";

const BASE_URL = "https://gateway.example.com";

const VALID_DISCOVERY = {
  contract_version: 1,
  issuer: BASE_URL,
  authorization_endpoint: `${BASE_URL}/auth/authorize`,
  token_endpoint: `${BASE_URL}/auth/token`,
  registration_endpoint: `${BASE_URL}/auth/register`,
  revocation_endpoint: `${BASE_URL}/auth/revoke`,
  resource: `${BASE_URL}/v1`,
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
};

let originalFetch: typeof globalThis.fetch;

before(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Real undici shape: opaque TypeError wrapping a coded cause Error. */
function undiciTypeError(
  code: string,
  message: string,
): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(message), { code }),
  });
}

function makeDomException(name: string, domCode: number, message: string) {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, { code: domCode });
  return err;
}

describe("fetchFailureMessage", () => {
  it("returns a plain no-cause error message verbatim", () => {
    assert.equal(
      fetchFailureMessage(new Error("network failure")),
      "network failure",
    );
  });

  it("returns String(input) for non-Error input", () => {
    assert.equal(fetchFailureMessage("boom"), "boom");
    assert.equal(fetchFailureMessage(42), "42");
    assert.equal(fetchFailureMessage(null), "null");
  });

  it("reports DNS failure (ENOTFOUND) with hint", () => {
    const err = undiciTypeError(
      "ENOTFOUND",
      "getaddrinfo ENOTFOUND gateway.example.com",
    );
    const msg = fetchFailureMessage(err);
    assert.ok(msg.includes("fetch failed"));
    assert.ok(msg.includes("ENOTFOUND"));
    assert.ok(msg.includes("getaddrinfo ENOTFOUND gateway.example.com"));
    assert.ok(msg.includes("DNS/VPN"));
  });

  it("reports EAI_AGAIN with the DNS hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("EAI_AGAIN", "getaddrinfo EAI_AGAIN gateway.example.com"),
    );
    assert.ok(msg.includes("EAI_AGAIN"));
    assert.ok(msg.includes("could not be resolved"));
  });

  it("reports ECONNREFUSED with hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:49999"),
    );
    assert.ok(msg.includes("ECONNREFUSED"));
    assert.ok(msg.includes("connection was refused"));
  });

  it("reports TLS trust failure (UNABLE_TO_GET_ISSUER_CERT_LOCALLY) with hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError(
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "unable to get local issuer certificate",
      ),
    );
    assert.ok(msg.includes("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"));
    assert.ok(msg.includes("--use-system-ca"));
    assert.ok(msg.includes("NODE_EXTRA_CA_CERTS"));
  });

  it("reports expired certificate (CERT_HAS_EXPIRED) with the TLS hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("CERT_HAS_EXPIRED", "certificate has expired"),
    );
    assert.ok(msg.includes("CERT_HAS_EXPIRED"));
    assert.ok(msg.includes("TLS certificate is not trusted"));
  });

  it("reports hostname mismatch (ERR_TLS_CERT_ALTNAME_INVALID) with the TLS hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError(
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "Hostname/IP does not match certificate's altnames",
      ),
    );
    assert.ok(msg.includes("ERR_TLS_CERT_ALTNAME_INVALID"));
    assert.ok(msg.includes("TLS certificate is not trusted"));
  });

  it("reports ERR_SSL wildcard codes with the TLS hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("ERR_SSL_WRONG_VERSION_NUMBER", "wrong version number"),
    );
    assert.ok(msg.includes("ERR_SSL_WRONG_VERSION_NUMBER"));
    assert.ok(msg.includes("TLS certificate is not trusted"));
  });

  it("reports ETIMEDOUT with the timeout hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("ETIMEDOUT", "connect ETIMEDOUT 10.0.0.1:443"),
    );
    assert.ok(msg.includes("ETIMEDOUT"));
    assert.ok(msg.includes("timed out before the gateway responded"));
  });

  it("reports UND_ERR_CONNECT_TIMEOUT with the timeout hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"),
    );
    assert.ok(msg.includes("UND_ERR_CONNECT_TIMEOUT"));
    assert.ok(msg.includes("timed out before the gateway responded"));
  });

  it("reports ECONNRESET with the reset hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("ECONNRESET", "read ECONNRESET"),
    );
    assert.ok(msg.includes("ECONNRESET"));
    assert.ok(msg.includes("reset by the peer"));
  });

  it("reports a DOMException TimeoutError (code 23) with the timeout hint", () => {
    const err = makeDomException(
      "TimeoutError",
      23,
      "The operation was aborted due to timeout",
    );
    const msg = fetchFailureMessage(err);
    assert.ok(msg.includes("The operation was aborted due to timeout"));
    assert.ok(msg.includes("(23:"));
    assert.ok(msg.includes("timed out before the gateway responded"));
  });

  it("does NOT treat an explicit abort (DOM code 20) as a timeout", () => {
    const err = makeDomException(
      "AbortError",
      20,
      "This operation was aborted",
    );
    const msg = fetchFailureMessage(err);
    assert.ok(!msg.includes("timed out before the gateway responded"));
  });

  it("simulated undici TLS shape mentions --use-system-ca", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(
        new Error("unable to get local issuer certificate"),
        { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" },
      ),
    });
    const msg = fetchFailureMessage(err);
    assert.ok(msg.includes("--use-system-ca"));
    assert.ok(msg.includes("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"));
  });

  it("terminates on a cyclic cause chain", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a;
    const msg = fetchFailureMessage(a);
    assert.ok(msg.includes("a"));
    assert.ok(msg.includes("b"));
  });

  it("does not go deeper than 5 cause links", () => {
    const leaf = Object.assign(new Error("leaf"), { code: "ECONNREFUSED" });
    let err: Error = leaf;
    for (let i = 0; i < 4; i++) {
      err = Object.assign(new Error(`layer-${i}`), { cause: err });
    }
    const msg = fetchFailureMessage(err);
    assert.ok(msg.includes("ECONNREFUSED"));

    // Beyond the 5-link cap the coded leaf is no longer reachable; the
    // message must still be produced without hanging.
    let far: Error = leaf;
    for (let i = 0; i < 20; i++) {
      far = Object.assign(new Error(`deep-${i}`), { cause: far });
    }
    const farMsg = fetchFailureMessage(far);
    assert.ok(typeof farMsg === "string" && farMsg.length > 0);
  });

  it("keeps the top-level message as a substring", () => {
    const err = undiciTypeError("ECONNREFUSED", "connect ECONNREFUSED");
    assert.ok(fetchFailureMessage(err).startsWith("fetch failed"));
  });
});

describe("client network-error wiring", () => {
  it("fetchModels rejects with CatalogError (not AuthError) naming the cause", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(
          new Error("unable to get local issuer certificate"),
          { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" },
        ),
      });
    };

    await assert.rejects(() => fetchModels(BASE_URL, "sk-test", 5000), (err) => {
      assert.ok(err instanceof CatalogError);
      assert.equal((err as CatalogError).code, "CATALOG_ERROR");
      assert.ok(
        (err as Error).message.includes("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"),
      );
      assert.ok((err as Error).message.includes("--use-system-ca"));
      return true;
    });
  });

  it("fetchCliAuthDiscovery rejects with DiscoveryError carrying the enriched message", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND host"), {
          code: "ENOTFOUND",
        }),
      });
    };

    await assert.rejects(
      () => fetchCliAuthDiscovery(BASE_URL, 5000),
      (err) => {
        assert.ok(err instanceof DiscoveryError);
        assert.equal((err as DiscoveryError).code, "DISCOVERY_ERROR");
        assert.ok(
          (err as Error).message.startsWith("Failed to fetch CLI auth discovery:"),
        );
        assert.ok((err as Error).message.includes("ENOTFOUND"));
        return true;
      },
    );
  });

  it("preserves verbatim message for a plain no-cause network error", async () => {
    globalThis.fetch = async () => {
      throw new Error("network failure");
    };
    await assert.rejects(() => fetchCliAuthDiscovery(BASE_URL, 5000), {
      message: /network failure/,
    });
  });
});