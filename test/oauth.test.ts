import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  LoopbackCallbackServer,
  parseCallbackParams,
} from "../extensions/lib/oauth.ts";
import { AuthError } from "../extensions/lib/errors.ts";

describe("LoopbackCallbackServer", () => {
  it("starts, captures callback, responds 200, then stops", async () => {
    const server = new LoopbackCallbackServer();
    const { port } = await server.start();
    assert.ok(Number.isInteger(port) && port > 0);

    const callbackPromise = server.waitForCallback();

    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/callback?code=abc&state=xyz`,
        (res) => resolve(res),
      );
      req.on("error", reject);
    });

    assert.equal(response.statusCode, 200);
    let body = "";
    for await (const chunk of response) {
      body += chunk;
    }
    assert.equal(
      body,
      "Signed in to LiteLLM. You can close this window and return to the terminal.",
    );

    const callbackUrl = await callbackPromise;
    assert.ok(callbackUrl.includes("/callback?"));
    assert.ok(callbackUrl.includes("code=abc"));
    assert.ok(callbackUrl.includes("state=xyz"));

    server.stop();

    await assert.rejects(
      () =>
        new Promise<void>((resolve) => {
          const req = http.get(
            `http://127.0.0.1:${port}/callback`,
            () => resolve(),
          );
          req.on("error", resolve);
        }).then(() => {
          throw new Error("Server still reachable after stop");
        }),
      /Server still reachable after stop/,
    );
  });

  it("buffers a callback that arrives before waitForCallback is attached", async () => {
    const server = new LoopbackCallbackServer();
    const { port } = await server.start();

    // Fire the callback request without awaiting it; do not attach the waiter yet.
    const fired = fetch(
      `http://127.0.0.1:${port}/callback?code=fast&state=pre`,
      { signal: AbortSignal.timeout(1000) },
    );

    // Wait a tick so the server has likely processed the request.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const callbackUrl = await Promise.race([
      server.waitForCallback(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("waitForCallback did not resolve")), 1000),
      ),
    ]);

    assert.ok(callbackUrl.includes("code=fast"));
    assert.ok(callbackUrl.includes("state=pre"));

    await fired.catch(() => {});
    server.stop();
  });

  it("returns 404 for non-/callback paths", async () => {
    const server = new LoopbackCallbackServer();
    const { port } = await server.start();

    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/not-callback`,
        (res) => resolve(res),
      );
      req.on("error", reject);
    });

    assert.equal(response.statusCode, 404);
    server.stop();
  });
});

describe("parseCallbackParams", () => {
  it("parses code and state", () => {
    const params = parseCallbackParams(
      "http://127.0.0.1:1234/callback?code=abc&state=xyz",
    );
    assert.equal(params.code, "abc");
    assert.equal(params.state, "xyz");
    assert.equal(params.error, undefined);
    assert.equal(params.errorDescription, undefined);
  });

  it("parses error params", () => {
    const params = parseCallbackParams(
      "http://127.0.0.1:1234/callback?error=access_denied&error_description=user+denied",
    );
    assert.equal(params.code, undefined);
    assert.equal(params.state, undefined);
    assert.equal(params.error, "access_denied");
    assert.equal(params.errorDescription, "user denied");
  });

  it("returns undefined fields for empty query", () => {
    const params = parseCallbackParams("http://127.0.0.1:1234/callback");
    assert.equal(params.code, undefined);
    assert.equal(params.state, undefined);
    assert.equal(params.error, undefined);
    assert.equal(params.errorDescription, undefined);
  });
});
