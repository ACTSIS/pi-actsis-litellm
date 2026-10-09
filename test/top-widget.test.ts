import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, it, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  buildTopHandler,
  readTopModelsWidgetEnabled,
  updateTopModelsWidgetEnabled,
  defaultsPrefs,
  type CommandDeps,
} from "../extensions/lib/commands.ts";

/**
 * Contract test: pins Gentle Shell's real sanitizeStatus behavior (from
 * gentle-pi/lib/shell-bar.ts). If gentle-pi changes it, this test fails and
 * the widget formatting must be revisited.
 */
function shellSanitizeStatus(text: string): string {
  return sanitizeTerminalTextLike(text.replace(/[\r\n\t]/g, " "))
    .replace(/ +/g, " ")
    .trim();
}

function sanitizeTerminalTextLike(value: string): string {
  // Replicates control-char stripping (strips ANSI/control chars, keeps NBSP).
  return value
    .replace(/\x1B\[[\d;]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u000d\u000e-\u001f\u007f-\u009f]/g, "");
}

describe("top-models status rows survive shell sanitization (NBSP columns)", () => {
  const rows = [
    { model: "oc/glm-5.3-flash", spend: 67.53 },
    { model: "oc/glm-5.3", spend: 30.94 },
    { model: "oc/deepseek-v4.1-flash", spend: 11.62 },
  ];

  it("buildTopModelsStatusEntries pads columns with NBSP, not ASCII spaces", async () => {
    const { buildTopModelsStatusEntries } = await import("../extensions/lib/usage.ts");
    const entries = buildTopModelsStatusEntries({
      windowLabel: "7d",
      rows,
      totalSpend: 113.03,
    });
    const dataRows = entries.slice(2);
    for (const e of dataRows) {
      assert.ok(e.text.includes("\u00a0"), `row lacks NBSP padding: ${e.text}`);
      assert.ok(!/\S {2,}\S/.test(e.text.replace(/\u00a0/g, "~")), `ASCII multi-space found: ${e.text}`);
    }
  });

  it("columns stay aligned AFTER the real sanitizeStatus transform", async () => {
    const { buildTopModelsStatusEntries } = await import("../extensions/lib/usage.ts");
    const entries = buildTopModelsStatusEntries({
      windowLabel: "7d",
      rows,
      totalSpend: 113.03,
    });
    const sanitized = entries.slice(2).map((e) => shellSanitizeStatus(e.text));
    const spendEnds = sanitized.map((t) => {
      const m = t.match(/\$\d+\.\d\d/);
      return m && m.index !== undefined ? m.index + m[0].length : -1;
    });
    assert.equal(new Set(spendEnds).size, 1, `unaligned after sanitize: ${sanitized}`);
    assert.ok(sanitized.every((t) => /[▰▱]$/.test(t)));
  });
});

describe("top models widget preference persistence", () => {
  let home: string;
  let prefsPath: string;

  before(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "top-prefs-"));
    prefsPath = path.join(home, "prefs.json");
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("defaults to enabled when the file is missing", async () => {
    assert.equal(await readTopModelsWidgetEnabled(prefsPath), true);
  });

  it("round-trips disable/enable", async () => {
    await updateTopModelsWidgetEnabled(prefsPath, false);
    assert.equal(await readTopModelsWidgetEnabled(prefsPath), false);
    await updateTopModelsWidgetEnabled(prefsPath, true);
    assert.equal(await readTopModelsWidgetEnabled(prefsPath), true);
  });

  it("defaults to enabled on corrupt prefs file", async () => {
    await writeFile(prefsPath, "not json{", "utf8");
    assert.equal(await readTopModelsWidgetEnabled(prefsPath), true);
  });

  it("defaults constant shape", () => {
    assert.deepEqual(defaultsPrefs(), { topModelsWidget: true });
  });
});

describe("actsis-litellm:top command", () => {
  let home: string;
  let deps: CommandDeps;

  before(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "top-cmd-"));
    deps = { ...(await import("../extensions/lib/commands.ts")).defaultCommandDeps() };
    deps.prefsPath = path.join(home, "prefs.json");
    deps.authPath = path.join(home, "auth.json");
    deps.cachePath = path.join(home, "cache.json");
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function makeCtx(): ExtensionCommandContext & { notifications: Array<{ message: string; level?: string }> } {
    const notifications: Array<{ message: string; level?: string }> = [];
    return {
      hasUI: true,
      ui: { notify: (m: string, l?: string) => notifications.push({ message: m, level: l }), select: async () => undefined, confirm: async () => false, input: async () => undefined },
      sessionManager: {},
      modelRegistry: { getProviderAuth: async () => undefined },
      model: undefined,
      getScopedModels: () => [],
      getSystemPrompt: () => "",
      notifications,
    } as unknown as ExtensionCommandContext & { notifications: Array<{ message: string; level?: string }> };
  }

  it("off disables the pref and reports new state", async () => {
    const handler = buildTopHandler(deps);
    const ctx = makeCtx();
    await handler("off", ctx);
    assert.equal(await readTopModelsWidgetEnabled(deps.prefsPath), false);
    assert.match(ctx.notifications[0].message, /off|disabled/i);
    assert.equal(ctx.notifications[0].level, "info");
  });

  it("on enables the pref and reports new state", async () => {
    const handler = buildTopHandler(deps);
    const ctx = makeCtx();
    await handler("on", ctx);
    assert.equal(await readTopModelsWidgetEnabled(deps.prefsPath), true);
    assert.match(ctx.notifications[0].message, /on|enabled/i);
  });

  it("no args toggles", async () => {
    const handler = buildTopHandler(deps);
    await readTopModelsWidgetEnabled(deps.prefsPath); // true
    const ctx = makeCtx();
    await handler("", ctx);
    assert.equal(await readTopModelsWidgetEnabled(deps.prefsPath), false);
    assert.match(ctx.notifications[0].message, /off|disabled/i);
  });

  it("rejects unknown args with a warning and no state change", async () => {
    const handler = buildTopHandler(deps);
    await updateTopModelsWidgetEnabled(deps.prefsPath, true);
    const ctx = makeCtx();
    await handler("maybe", ctx);
    assert.equal(await readTopModelsWidgetEnabled(deps.prefsPath), true);
    assert.equal(ctx.notifications[0].level, "warning");
  });
});