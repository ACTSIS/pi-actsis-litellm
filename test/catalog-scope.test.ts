import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  loadCachedScope,
  catalogScopeLine,
  catalogScopeHint,
  saveCachedModels,
  loadCachedModels,
  type CachedCatalogScope,
} from "../extensions/lib/catalog.ts";

describe("catalog scope metadata", () => {
  it("save/load roundtrip preserves the credential scope", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cat-scope-"));
    const cachePath = path.join(dir, "cache.json");
    const scope: CachedCatalogScope = {
      kind: "oauth",
      userId: "2ed0da75-556d",
      teamId: "ad59169e-f0c9",
    };
    await saveCachedModels(cachePath, [], scope);
    const loaded = await loadCachedScope(cachePath);
    assert.deepEqual(loaded, scope);
    // Models roundtrip still works with the extra field in the file.
    assert.deepEqual(await loadCachedModels(cachePath), []);
  });

  it("tolerates a v2 cache without scope metadata (returns null)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cat-scope-"));
    const cachePath = path.join(dir, "cache.json");
    await writeFile(
      cachePath,
      JSON.stringify({ version: 2, fetchedAt: Date.now(), models: [] }),
      "utf8",
    );
    assert.equal(await loadCachedScope(cachePath), null);
  });

  it("scope line renders oauth session with team short id", () => {
    const line = catalogScopeLine({
      kind: "oauth",
      userId: "2ed0da75-556d",
      teamId: "ad59169e-f0c9",
    });
    assert.match(line, /OAuth session/);
    assert.match(line, /team ad59169e-f0c9/);
  });

  it("scope line renders API-key credentials", () => {
    const line = catalogScopeLine({ kind: "api_key" });
    assert.match(line, /API key/);
  });

  it("scope line renders unknown when no metadata exists", () => {
    assert.match(catalogScopeLine(null), /unknown/i);
  });

  it("oc/*-only catalog with a team scope yields the re-login hint", () => {
    const hint = catalogScopeHint(
      [{ id: "oc/glm-5.2" }, { id: "oc/gpt-oss:20b" }],
      { kind: "oauth", userId: "u1", teamId: "t1" },
    );
    assert.match(hint ?? "", /login again/i);
    assert.match(hint ?? "", /team/);
  });

  it("mixed catalog with the same team scope yields no hint", () => {
    const hint = catalogScopeHint(
      [{ id: "oc/glm-5.2" }, { id: "gpt-oss-120b" }],
      { kind: "oauth", userId: "u1", teamId: "t1" },
    );
    assert.equal(hint, undefined);
  });

  it("team-less scope never yields the hint", () => {
    const hint = catalogScopeHint([{ id: "oc/glm-5.2" }], { kind: "oauth" });
    assert.equal(hint, undefined);
  });
});