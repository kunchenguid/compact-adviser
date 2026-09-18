import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../src/config.ts";
import { RECENT_TAIL_MESSAGES } from "../src/context.ts";
import { assistant, temp } from "./helpers.ts";

const root = process.cwd();
const binary = process.env.COMPACT_TEST_PI_BIN ?? "";
assert.ok(binary, "Set COMPACT_TEST_PI_BIN to the actual Pi executable (not npm's injected PATH).");
const pinnedPi = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies[
  "@earendil-works/pi-coding-agent"
] as string;
function atLeast(version: string, minimum: string): boolean {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/, "")
      .split(".")
      .slice(0, 3)
      .map((n) => Number(n));
  const a = parts(version);
  const b = parts(minimum);
  if (![...a, ...b].every(Number.isFinite) || a.length < 2 || b.length < 2) return false;
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}
function run(
  t: TestContext,
  mode: "hint" | "auto",
  actions: { send: string; wait?: string }[],
  installed = false,
  fixture: { inputTokens?: number; coordinating?: boolean; logRequests?: boolean } = {},
) {
  const dir = temp(t),
    store = new ConfigStore(dir);
  store.update({
    mode,
    autoAcknowledged: mode === "auto",
    logRequests: fixture.logRequests ?? false,
  });
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  sm.appendMessage({
    role: "user",
    content: "Finish and save the report, then read it next.",
    timestamp: Date.now(),
  });
  sm.appendMessage(assistant("Earlier exploration. ".repeat(6000)));
  for (let i = 0; i < RECENT_TAIL_MESSAGES; i++) sm.appendMessage(assistant(`Earlier step ${i}`));
  const log = join(dir, "events.jsonl");
  if (installed) {
    const product = join(dir, "package");
    mkdirSync(product);
    for (const file of ["package.json", "package-lock.json", "src"])
      cpSync(join(root, file), join(product, file), { recursive: true });
    execFileSync(
      "npm",
      ["ci", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: product, timeout: 60000 },
    );
    assert.ok(existsSync(join(product, "node_modules/proper-lockfile")));
    assert.ok(!existsSync(join(product, "node_modules/@earendil-works/pi-coding-agent")));
    execFileSync(binary, ["install", product], {
      cwd: dir,
      env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
      timeout: 30000,
    });
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    assert.equal(settings.packages.length, 1);
  }
  const spec = {
    cwd: dir,
    command: [
      binary,
      ...(installed ? [] : ["--no-extensions", "-e", root]),
      "-e",
      join(root, "test/fixtures/runtime.ts"),
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      "--no-approve",
      "--no-tools",
      "--provider",
      "compact-fixture",
      "--model",
      "local",
      "--thinking",
      "off",
      "--session",
      sm.getSessionFile(),
      "--session-dir",
      join(dir, "sessions"),
    ],
    env: {
      PI_CODING_AGENT_DIR: dir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      TYPESAFE_API_KEY: "test-key-not-a-secret",
      COMPACT_TEST_LOG: log,
      COMPACT_TEST_INPUT_TOKENS: String(fixture.inputTokens ?? 45000),
      COMPACT_TEST_COORDINATING: fixture.coordinating ? "1" : "0",
    },
    actions,
    output: join(dir, "terminal.log"),
  };
  const result = execFileSync("python3", [join(root, "test/fixtures/tui.py")], {
    input: JSON.stringify(spec),
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const events = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const requestLog = join(dir, "compact-adviser-requests.jsonl");
  const logLines = existsSync(requestLog)
    ? readFileSync(requestLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { dir, store, result: JSON.parse(result), events, requestLog, logLines };
}

test("signed Pi: native configuration input is actually prefilled", (t) => {
  const installed = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  assert.ok(
    atLeast(installed, "0.82.0"),
    `Set COMPACT_TEST_PI_BIN to Pi 0.82.0 or newer (got ${installed}; development SDK ${pinnedPi}).`,
  );
  const r = run(t, "hint", [
    { send: "/compact-adviser\r", wait: "Compact adviser (saved for all sessions)" },
    { send: "\x1b[B\r", wait: "Minimum context tokens" },
    { send: "\r", wait: "Minimum context saved: 40,000 tokens" },
    { send: "\x1b[B\r", wait: "Minimum context tokens" },
    { send: "\x01\x0b60000\r", wait: "Minimum context saved: 60,000 tokens" },
    { send: "\x1b[B\x1b[B\x1b[B\x1b[B\r", wait: "Minimum context saved: 40,000 tokens" },
  ]);
  assert.equal(r.store.read().minContextTokens, 40000);
  assert.ok(r.result.ok);
});

test("signed Pi: real settled event produces the hint and a complete Jev decision log", (t) => {
  const r = run(
    t,
    "hint",
    [
      {
        send: "Finish the fixture report.\r",
        wait: "Compact adviser: work appears completed or recorded. Run /compact to save tokens.",
      },
    ],
    false,
    { logRequests: true },
  );
  assert.equal(r.events.filter((e) => e.event === "jev").length, 1);
  assert.ok(r.events.some((e) => e.event === "start" && e.mode === "tui"));
  assert.ok(r.events.some((e) => e.event === "settled" && e.idle));
  assert.ok(!r.events.some((e) => e.event === "compacted"));
  assert.equal(r.logLines.length, 2);
  const [request, response] = r.logLines;
  assert.equal(request.kind, "request");
  assert.equal(response.kind, "response");
  assert.equal(response.id, request.id);
  assert.equal(response.answers.done.choice, "finished");
  assert.equal(response.answers.shape.choice, "hands_on");
  assert.equal(typeof response.score, "number");
  assert.equal(typeof response.usage, "number");
  assert.equal(typeof response.floor, "number");
  assert.equal(response.qualifies, true);
  assert.equal(readFileSync(r.requestLog, "utf8").includes("test-key-not-a-secret"), false);
  if (process.env.COMPACT_TEST_LOG_EVIDENCE) {
    cpSync(r.requestLog, process.env.COMPACT_TEST_LOG_EVIDENCE);
  }
});

test("signed Pi: knee floor withholds a coordinating hint until 90% usage", (t) => {
  const early = run(
    t,
    "hint",
    [
      { send: "Finish the low-usage fixture report.\r", wait: "This phase is complete" },
      { send: "/compact-adviser status\r", wait: "hint floor 0.87" },
    ],
    false,
    { inputTokens: 45000, coordinating: true, logRequests: true },
  );
  assert.equal(early.events.filter((e) => e.event === "jev").length, 1);
  assert.ok(
    !early.result.tail.includes(
      "Compact adviser: work appears completed or recorded. Run /compact to save tokens.",
    ),
  );
  assert.equal(early.logLines.length, 2);
  assert.equal(early.logLines[1].kind, "response");
  assert.equal(early.logLines[1].qualifies, false);
  assert.equal(typeof early.logLines[1].score, "number");
  assert.equal(typeof early.logLines[1].usage, "number");
  assert.equal(typeof early.logLines[1].floor, "number");
  assert.equal(readFileSync(early.requestLog, "utf8").includes("test-key-not-a-secret"), false);

  const full = run(
    t,
    "hint",
    [
      {
        send: "Finish the nearly-full fixture report.\r",
        wait: "Compact adviser: work appears completed or recorded. Run /compact to save tokens.",
      },
    ],
    false,
    { inputTokens: 245000, coordinating: true },
  );
  assert.equal(full.events.filter((e) => e.event === "jev").length, 1);
});

test("signed Pi: opt-in auto uses native compaction and resets usage", (t) => {
  const r = run(t, "auto", [
    { send: "Finish the fixture report.\r", wait: "Compact adviser: compaction completed." },
  ]);
  assert.equal(r.events.filter((e) => e.event === "jev").length, 1);
  assert.ok(r.events.some((e) => e.event === "compacted" && e.tokens === null));
});

test("signed Pi: production-only independent package installs and loads through its manifest", (t) => {
  const r = run(
    t,
    "hint",
    [
      {
        send: "Finish the installed package fixture.\r",
        wait: "Compact adviser: work appears completed or recorded. Run /compact to save tokens.",
      },
    ],
    true,
  );
  assert.equal(r.events.filter((e) => e.event === "jev").length, 1);
});
