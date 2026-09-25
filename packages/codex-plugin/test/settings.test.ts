// The settings file, the per-session records, and the CLI that edits both.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";
import {
  AUTO_UNAVAILABLE,
  ConfigStore,
  DEFAULT_CONFIG,
  parseMinimum,
  parseMode,
  parseSavedApiKey,
} from "../src/config.ts";
import { adviserRoot, codexHome } from "../src/paths.ts";
import { initialState } from "../src/state.ts";
import { SessionStore } from "../src/store.ts";
import { type Lab, makeLab } from "./support.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");

function cli(lab: Lab, overrides: Partial<{ env: NodeJS.ProcessEnv }> = {}) {
  return {
    env: { CODEX_HOME: lab.home } as NodeJS.ProcessEnv,
    now: () => 1_000_000,
    cwd: lab.cwd,
    readSecret: async () => "tsk-typed-by-hand",
    ...overrides,
  };
}

async function withLab(body: (lab: Lab) => void | Promise<void>): Promise<void> {
  const lab = makeLab();
  try {
    await body(lab);
  } finally {
    lab.cleanup();
  }
}

test("CODEX_HOME decides where the adviser keeps its own directory", () => {
  assert.equal(codexHome({ CODEX_HOME: "/somewhere/.codex" }), "/somewhere/.codex");
  assert.ok(codexHome({}).endsWith("/.codex"));
  assert.ok(adviserRoot({ CODEX_HOME: "/somewhere" }).endsWith("/somewhere/compact-adviser"));
});

test("an absent settings file reads as the documented defaults", async () => {
  await withLab((lab) => {
    assert.deepEqual(new ConfigStore(adviserRoot({ CODEX_HOME: lab.home })).read(), DEFAULT_CONFIG);
  });
});

test("settings round-trip and merge field by field", async () => {
  await withLab((lab) => {
    const store = new ConfigStore(adviserRoot({ CODEX_HOME: lab.home }));
    store.update({ minContextTokens: 60000 });
    store.update({ logRequests: true });
    assert.deepEqual(store.read(), {
      version: 1,
      mode: "hint",
      minContextTokens: 60000,
      contextBudgetTokens: 0,
      logRequests: true,
    });
  });
});

test("a saved key is kept out of the readable settings surface but stays usable", async () => {
  await withLab((lab) => {
    const store = new ConfigStore(adviserRoot({ CODEX_HOME: lab.home }));
    store.update({ typesafeApiKey: "tsk-saved" });
    assert.equal(store.read().typesafeApiKey, "tsk-saved");
    assert.equal((readFileSync(store.path, "utf8").match(/\n/g) ?? []).length > 0, true);
    store.update({ typesafeApiKey: "" });
    assert.equal(store.read().typesafeApiKey, undefined);
  });
});

test("an unreadable or unsupported settings file is reported, never silently replaced", async () => {
  await withLab((lab) => {
    const store = new ConfigStore(adviserRoot({ CODEX_HOME: lab.home }));
    store.update({ mode: "hint" });
    writeFileSync(store.path, JSON.stringify({ version: 2, mode: "hint" }));
    assert.throws(() => store.read(), /Cannot read compact-adviser settings/);
    writeFileSync(store.path, JSON.stringify({ version: 1, mode: "auto", minContextTokens: 1 }));
    assert.throws(() => store.read(), /Cannot read compact-adviser settings/);
    writeFileSync(store.path, "x".repeat(9000));
    assert.throws(() => store.read(), /Cannot read compact-adviser settings/);
    chmodSync(store.path, 0o600);
  });
});

test("input parsing refuses what the product does not accept", () => {
  assert.equal(parseMinimum("60000"), 60000);
  assert.throws(() => parseMinimum("40k"), /positive whole number/);
  assert.throws(() => parseMinimum("0"), /positive whole number/);
  assert.equal(parseMode("hint"), "hint");
  assert.equal(parseMode("off"), "off");
  assert.throws(() => parseMode("auto"), /not available on Codex/);
  assert.throws(() => parseMode("sometimes"), /Enter hint or off/);
  assert.equal(parseSavedApiKey("  tsk-1  "), "tsk-1");
  assert.throws(() => parseSavedApiKey(""), /Enter a TypeSafe API key/);
  assert.throws(() => parseSavedApiKey("tsk\u0007"), /control characters/);
  assert.throws(() => parseSavedApiKey("x".repeat(1025)), /too long/);
});

test("a malformed session record restarts conservatively instead of advising", async () => {
  await withLab((lab) => {
    const store = new SessionStore(adviserRoot({ CODEX_HOME: lab.home }));
    store.write("s1", initialState(false, 10));
    writeFileSync(store.path("s1"), "{ not json");
    const record = store.read("s1", 20);
    assert.equal(record.state.compacted, true);
    assert.equal(record.state.snoozeUntil, 3);
  });
});

test("the newest session record is the one the CLI reports on", async () => {
  await withLab((lab) => {
    const store = new SessionStore(adviserRoot({ CODEX_HOME: lab.home }));
    store.write("older", initialState(false, 1), { tokens: 10, window: 100 });
    store.write("newer", initialState(false, 2), { tokens: 50000, window: 200000 });
    const latest = store.latest();
    assert.equal(latest?.id, "newer");
    assert.equal(latest?.tokens, 50000);
    assert.equal(latest?.window, 200000);
  });
});

test("a session id that is not a safe file name still gets exactly one record", async () => {
  await withLab((lab) => {
    const store = new SessionStore(adviserRoot({ CODEX_HOME: lab.home }));
    store.write("../../escape/../id", { ...initialState(false, 1), completed: 3 });
    assert.equal(store.read("../../escape/../id", 1).state.completed, 3);
    assert.equal(store.latest()?.state.completed, 3);
    assert.equal(
      resolve(store.path("../../escape/../id")),
      resolve(store.directory, "_.._escape_.._id.json"),
      "a hostile session id cannot address a file outside the sessions directory",
    );
  });
});

test("the CLI saves each setting and reports the mode change", async () => {
  await withLab(async (lab) => {
    const store = new ConfigStore(adviserRoot({ CODEX_HOME: lab.home }));
    assert.match(await run(["off"], cli(lab)), /Off saved/);
    assert.equal(store.read().mode, "off");
    assert.match(await run(["hint"], cli(lab)), /Hints only saved/);
    assert.equal(store.read().mode, "hint");
    assert.match(await run(["threshold", "60000"], cli(lab)), /60,000 tokens/);
    assert.equal(store.read().minContextTokens, 60000);
    assert.match(await run(["threshold", "default"], cli(lab)), /40,000 tokens/);
    assert.equal(store.read().minContextTokens, 40000);
    assert.match(await run(["budget", "450000"], cli(lab)), /450,000 tokens/);
    assert.equal(store.read().contextBudgetTokens, 450000);
    assert.match(await run(["status"], cli(lab)), /Budget: 450,000 tokens\./);
    await assert.rejects(run(["budget", "450k"], cli(lab)), /whole number/);
    assert.match(await run(["budget", "off"], cli(lab)), /budget off/);
    assert.equal(store.read().contextBudgetTokens, 0);
    assert.match(await run(["log", "on"], cli(lab)), /logging on/);
    assert.equal(store.read().logRequests, true);
    assert.match(await run(["log", "off"], cli(lab)), /logging off/);
    assert.equal(store.read().logRequests, false);
  });
});

test("the CLI saves and clears a key without ever printing it", async () => {
  await withLab(async (lab) => {
    const store = new ConfigStore(adviserRoot({ CODEX_HOME: lab.home }));
    const saved = await run(["key", "set"], cli(lab));
    assert.equal(store.read().typesafeApiKey, "tsk-typed-by-hand");
    assert.ok(!saved.includes("tsk-typed-by-hand"));
    assert.equal(await run(["key", "status"], cli(lab)), "Key: saved");
    assert.match(await run(["key", "clear"], cli(lab)), /cleared/);
    assert.equal(store.read().typesafeApiKey, undefined);
    assert.equal(await run(["key", "status"], cli(lab)), "Key: missing");
  });
});

test("key set never writes the typed secret to the terminal", async () => {
  await withLab((lab) => {
    const secret = "tsk-must-never-echo";
    const result = spawnSync(process.execPath, [CLI, "key", "set"], {
      encoding: "utf8",
      input: `${secret}\n`,
      env: { ...process.env, CODEX_HOME: lab.home },
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /TypeSafe API key saved/);
    assert.ok(!result.stdout.includes(secret));
    assert.ok(!result.stderr.includes(secret));
    assert.equal(
      new ConfigStore(adviserRoot({ CODEX_HOME: lab.home })).read().typesafeApiKey,
      secret,
    );
  });
});

test("status names the mode, the key source, and the latest session's cooldown", async () => {
  await withLab(async (lab) => {
    const root = adviserRoot({ CODEX_HOME: lab.home });
    new SessionStore(root).write("s1", initialState(false, 1), { tokens: 50000, window: 200000 });
    const text = await run(
      ["status"],
      cli(lab, { env: { CODEX_HOME: lab.home, TYPESAFE_API_KEY: "tsk-env" } }),
    );
    assert.match(text, /Mode: hint\./);
    assert.match(text, /Minimum: 40,000 tokens\./);
    assert.match(text, /Key: env\./);
    assert.match(text, /No cooldown/);
    assert.match(text, /25% of the window; hint floor 0\.82/);
    assert.ok(!text.includes("tsk-env"), "status never prints the key");
  });
});

test("status reports the floor the stored profile gates with", async () => {
  await withLab(async (lab) => {
    const root = adviserRoot({ CODEX_HOME: lab.home });
    new ConfigStore(root).update({
      profile: JSON.stringify({ version: 1, coordinationWeight: 0, floors: [[0, 0.6]] }),
    });
    new SessionStore(root).write("s1", initialState(false, 1), { tokens: 50000, window: 200000 });
    const text = await run(["status"], cli(lab));
    assert.match(text, /25% of the window; hint floor 0\.60/);
  });
});

test("COMPACT_ADVISER_DISABLE makes the CLI take no action", async () => {
  await withLab(async (lab) => {
    const message = await run(
      ["off"],
      cli(lab, { env: { CODEX_HOME: lab.home, COMPACT_ADVISER_DISABLE: "1" } }),
    );
    assert.equal(message, "");
    assert.equal(new ConfigStore(adviserRoot({ CODEX_HOME: lab.home })).read().mode, "hint");
  });
});

test("the CLI explains that automatic mode does not exist on Codex", async () => {
  await withLab(async (lab) => {
    await assert.rejects(run(["auto"], cli(lab)), /not available on Codex/);
    assert.ok(AUTO_UNAVAILABLE.includes("/compact"));
    assert.match(await run([], cli(lab)), /Automatic compaction is not available on Codex/);
    await assert.rejects(run(["nonsense"], cli(lab)), /Usage: compact-adviser/);
  });
});
