import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePkce, randomState } from "../extensions/lib/pkce.ts";
import { createHash } from "node:crypto";

function base64url(input: string | Buffer): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer.toString("base64url").replace(/=+$/, "");
}

describe("generatePkce", () => {
  it("produces a verifier between 43 and 128 characters", () => {
    const pair = generatePkce();
    assert.ok(pair.verifier.length >= 43);
    assert.ok(pair.verifier.length <= 128);
  });

  it("produces a challenge equal to base64url(sha256(verifier))", () => {
    const pair = generatePkce();
    const expected = base64url(createHash("sha256").update(pair.verifier, "utf8").digest());
    assert.equal(pair.challenge, expected);
  });

  it("produces distinct verifiers on successive calls", () => {
    const a = generatePkce();
    const b = generatePkce();
    assert.notEqual(a.verifier, b.verifier);
    assert.notEqual(a.challenge, b.challenge);
  });
});

describe("randomState", () => {
  it("returns a base64url string", () => {
    const state = randomState();
    assert.ok(/^[A-Za-z0-9_-]+$/.test(state));
  });

  it("returns unique values", () => {
    const values = new Set<string>();
    for (let i = 0; i < 50; i++) {
      values.add(randomState());
    }
    assert.equal(values.size, 50);
  });
});
