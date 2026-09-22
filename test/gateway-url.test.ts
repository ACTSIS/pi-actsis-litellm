import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import {
  readStoredCredentialGatewayUrl,
  pickGatewayUrl,
  upgradeHttpToHttps,
} from "../extensions/lib/gateway-url.ts";

describe("upgradeHttpToHttps", () => {
  it("upgrades http to https", () => {
    assert.equal(
      upgradeHttpToHttps("http://gateway.example.com"),
      "https://gateway.example.com",
    );
  });

  it("leaves https unchanged", () => {
    assert.equal(
      upgradeHttpToHttps("https://gateway.example.com"),
      "https://gateway.example.com",
    );
  });
});

describe("pickGatewayUrl", () => {
  it("prefers env over file and stored", () => {
    const result = pickGatewayUrl({
      env: "https://env.example.com",
      file: "https://file.example.com",
      stored: "https://stored.example.com",
    });
    assert.deepEqual(result, { url: "https://env.example.com", source: "env" });
  });

  it("prefers file over stored", () => {
    const result = pickGatewayUrl({
      file: "https://file.example.com",
      stored: "https://stored.example.com",
    });
    assert.deepEqual(result, {
      url: "https://file.example.com",
      source: "config-file",
    });
  });

  it("uses stored when nothing else is available", () => {
    const result = pickGatewayUrl({ stored: "https://stored.example.com" });
    assert.deepEqual(result, {
      url: "https://stored.example.com",
      source: "stored-credential",
    });
  });

  it("returns null when nothing is available", () => {
    assert.equal(pickGatewayUrl({}), null);
  });
});

describe("readStoredCredentialGatewayUrl", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "actsis-litellm-gw-url-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  after(async () => {
    process.env.HOME = originalHome;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts and upgrades an http token endpoint origin to https", async () => {
    const authPath = path.join(tmpDir, "auth.json");
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(
      authPath,
      JSON.stringify(
        {
          "actsis-litellm": {
            type: "oauth",
            access: "a",
            refresh: "r",
            tokenEndpoint: "http://gateway.example.com/token",
          },
        },
        null,
        2,
      ),
    );

    const url = await readStoredCredentialGatewayUrl(authPath, "actsis-litellm");
    assert.equal(url, "https://gateway.example.com");
  });

  it("returns null for a missing auth file", async () => {
    const url = await readStoredCredentialGatewayUrl(
      path.join(tmpDir, "missing-auth.json"),
      "actsis-litellm",
    );
    assert.equal(url, null);
  });

  it("returns null when the provider entry is absent", async () => {
    const authPath = path.join(tmpDir, "auth.json");
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(
      authPath,
      JSON.stringify(
        {
          "other-provider": {
            type: "oauth",
            tokenEndpoint: "https://other.example.com/token",
          },
        },
        null,
        2,
      ),
    );

    const url = await readStoredCredentialGatewayUrl(authPath, "actsis-litellm");
    assert.equal(url, null);
  });

  it("returns null for an invalid token endpoint", async () => {
    const authPath = path.join(tmpDir, "auth.json");
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(
      authPath,
      JSON.stringify(
        {
          "actsis-litellm": {
            type: "oauth",
            tokenEndpoint: "not-a-url",
          },
        },
        null,
        2,
      ),
    );

    const url = await readStoredCredentialGatewayUrl(authPath, "actsis-litellm");
    assert.equal(url, null);
  });
});
