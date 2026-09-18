// hooks/run.sh: the shim Codex actually invokes.
//
// Codex does not give a hook the session's PATH; it rebuilds one from a shell snapshot. On a
// machine whose Node comes from a version manager that is only loaded in an interactive rc
// file, that PATH has no `node`, and a bare `node` would exit 127 and paint "Hook failed" in
// the user's scrollback at every turn. These cases pin the two behaviours that prevents.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeLab } from "./support.ts";

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(PACKAGE, "hooks", "run.sh");
const ENTRY = join(PACKAGE, "src", "hook.ts");
/** A PATH with no Node on it at all, as Codex's rebuilt hook PATH can be. */
const NO_NODE_PATH = "/nonexistent-bin";

function fakeNode(picked: string, version = "22.18.0"): string {
  return [
    "#!/bin/sh",
    'if [ "$1" = "-p" ]; then',
    `  echo ${JSON.stringify(version)}`,
    "  exit 0",
    "fi",
    `echo ${JSON.stringify(JSON.stringify({ picked }))}`,
    "",
  ].join("\n");
}

function launch(env: NodeJS.ProcessEnv) {
  return spawnSync("/bin/sh", [LAUNCHER, ENTRY], {
    input: JSON.stringify({ hook_event_name: "Stop" }),
    encoding: "utf8",
    env,
    timeout: 30000,
  });
}

test("with no Node anywhere the hook says nothing and does not fail the turn", () => {
  const lab = makeLab();
  try {
    const result = launch({ PATH: NO_NODE_PATH, HOME: lab.home, CODEX_HOME: lab.home });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "{}");
  } finally {
    lab.cleanup();
  }
});

test("COMPACT_ADVISER_NODE names the interpreter when PATH has none", () => {
  const lab = makeLab();
  try {
    const result = launch({
      PATH: NO_NODE_PATH,
      HOME: lab.home,
      CODEX_HOME: lab.home,
      COMPACT_ADVISER_NODE: process.execPath,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "{}", "the entry point ran and answered for itself");
  } finally {
    lab.cleanup();
  }
});

test("a version manager's Node under HOME is found when PATH has none", () => {
  const lab = makeLab();
  try {
    const managed = join(lab.home, ".nvm", "versions", "node", "v24.0.0", "bin");
    mkdirSync(managed, { recursive: true });
    symlinkSync(process.execPath, join(managed, "node"));
    const result = launch({ PATH: NO_NODE_PATH, HOME: lab.home, CODEX_HOME: lab.home });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "{}");
  } finally {
    lab.cleanup();
  }
});

test("an nvm Node whose path contains a space is still found", () => {
  const lab = makeLab();
  try {
    const home = join(lab.home, "user home");
    const managed = join(home, ".nvm", "versions", "node", "v24.0.0", "bin");
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "node"), fakeNode("nvm-space"));
    chmodSync(join(managed, "node"), 0o755);
    const result = launch({ PATH: NO_NODE_PATH, HOME: home, CODEX_HOME: lab.home });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '{"picked":"nvm-space"}');
  } finally {
    lab.cleanup();
  }
});

test("a Node on PATH is preferred over the fallback search", () => {
  const lab = makeLab();
  try {
    const bin = join(lab.home, "bin");
    mkdirSync(bin, { recursive: true });
    // Not a real Node: it only has to prove which binary the launcher chose.
    writeFileSync(join(bin, "node"), fakeNode("path"));
    chmodSync(join(bin, "node"), 0o755);
    const result = launch({ PATH: bin, HOME: lab.home, CODEX_HOME: lab.home });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '{"picked":"path"}');
  } finally {
    lab.cleanup();
  }
});

test("an under-minimum Node is skipped for one that can run the entry point", () => {
  const lab = makeLab();
  try {
    const bin = join(lab.home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "node"), fakeNode("old", "20.11.0"));
    chmodSync(join(bin, "node"), 0o755);
    const managed = join(lab.home, ".nvm", "versions", "node", "v24.0.0", "bin");
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "node"), fakeNode("nvm", "24.0.0"));
    chmodSync(join(managed, "node"), 0o755);
    const result = launch({ PATH: bin, HOME: lab.home, CODEX_HOME: lab.home });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '{"picked":"nvm"}');
  } finally {
    lab.cleanup();
  }
});
