// The product, driven through the real CLI the hooks and the status line run.
//
// Every case here starts from a Grok-shaped session directory and a loopback TypeSafe fixture
// and asserts what the person would see: a hint on the status row, or nothing at all.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HINT } from "../lib/statusline.ts";
import { resetSessionState } from "../lib/store.ts";
import {
  lab,
  PACKAGE_ROOT,
  runCli,
  runLauncher,
  runShell,
  statusPayload,
  stopPayload,
  typesafeFixture,
  workedHistory,
  writeHistory,
  writeSignals,
} from "./support.ts";

function keyed(fixture: { url: string }) {
  return { COMPACT_ADVISER_TEST_ENDPOINT: fixture.url, TYPESAFE_API_KEY: "tsk-test-key" };
}

async function judgeTurn(
  t: Parameters<typeof lab>[0],
  options: { tokens?: number; marker?: string } = {},
) {
  const l = lab(t);
  const fixture = await typesafeFixture(t);
  writeHistory(l, workedHistory(options.marker ?? "one"));
  writeSignals(l, options.tokens ?? 150000);
  return { l, fixture };
}

test("a qualifying checkpoint puts the hint on the status row, and the Stop gate stays silent", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  const stop = await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l),
    env: keyed(fixture),
  });
  assert.equal(stop.code, 0);
  // The Stop hook's stdout is the turn's control channel; anything on it could keep the agent
  // working, which would put the advice in the model's context instead of the person's.
  assert.equal(stop.stdout, "");
  assert.equal(fixture.bodies.length, 1);

  const row = await runCli(["status-line"], { lab: l, stdin: statusPayload(l) });
  assert.match(row.stdout, /project │ Grok 4\.6 │ 24% ctx/);
  assert.ok(row.stdout.includes(HINT));
});

test("a stored profile controls the real hook verdict", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  mkdirSync(l.dataDir, { recursive: true });
  writeFileSync(
    join(l.dataDir, "settings.json"),
    JSON.stringify({
      version: 1,
      profile: JSON.stringify({ version: 1, coordinationWeight: 1, floors: [[0, 1]] }),
    }),
  );
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.equal(fixture.bodies.length, 1);
  const row = await runCli(["status-line"], { lab: l, stdin: statusPayload(l) });
  assert.ok(!row.stdout.includes(HINT));
});

test("a profile that turns invalid while the judge is pending retires the hint and settles the session", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.ok(
    (await runCli(["status-line"], { lab: l, stdin: statusPayload(l) })).stdout.includes(HINT),
  );
  const statePath = join(l.dataDir, "sessions", `${l.sessionId}.json`);
  const seeded = JSON.parse(readFileSync(statePath, "utf8")) as { failures: number };
  writeFileSync(statePath, JSON.stringify({ ...seeded, failures: 3 }));
  writeHistory(l, [...workedHistory("one"), ...workedHistory("two").slice(1)]);
  fixture.onRequest = () =>
    writeFileSync(join(l.dataDir, "settings.json"), '{"version":1,"profile":"not a profile"}');
  await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l, { promptId: "prompt-2" }),
    env: keyed(fixture),
  });
  assert.equal(fixture.bodies.length, 2);
  assert.ok(
    !(await runCli(["status-line"], { lab: l, stdin: statusPayload(l) })).stdout.includes(HINT),
  );
  const settled = JSON.parse(readFileSync(statePath, "utf8")) as {
    failures: number;
    retryAfter: number;
  };
  assert.equal(settled.failures, 0);
  assert.equal(settled.retryAfter, 0);
});

test("a below-floor judgment discarded by a profile change mid-flight does not start the re-ask wait", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  fixture.verdict = { finished: 0.6, handsOn: 0.6 };
  fixture.onRequest = () =>
    writeFileSync(
      join(l.dataDir, "settings.json"),
      JSON.stringify({
        version: 1,
        profile: JSON.stringify({ version: 1, coordinationWeight: 0.5, floors: [[0, 0.9]] }),
      }),
    );
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.equal(fixture.bodies.length, 1);
  const statePath = join(l.dataDir, "sessions", `${l.sessionId}.json`);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    judgedTokens: number | null;
    judgedAt: number | null;
  };
  assert.deepEqual([state.judgedTokens, state.judgedAt], [null, null]);
});

test("a compaction that lands while TypeSafe answers keeps its reset", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  fixture.verdict = { finished: 0.6, handsOn: 0.6 };
  // What the PostCompact hook does, run synchronously inside the in-flight request.
  fixture.onRequest = () =>
    resetSessionState(join(l.dataDir, "sessions", `${l.sessionId}.json`), Date.now());
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.equal(fixture.bodies.length, 1);
  const state = JSON.parse(
    readFileSync(join(l.dataDir, "sessions", `${l.sessionId}.json`), "utf8"),
  ) as { compacted: boolean; completed: number; judgedTokens: number | null };
  assert.deepEqual([state.compacted, state.completed, state.judgedTokens], [true, 0, null]);
});

for (const [name, settings] of [
  ["a raised minimum", { version: 1, minContextTokens: 900000 }],
  ["mode off", { version: 1, mode: "off" }],
] as const) {
  test(`${name} saved while TypeSafe answers discards the verdict`, async (t) => {
    const { l, fixture } = await judgeTurn(t);
    fixture.onRequest = () =>
      writeFileSync(join(l.dataDir, "settings.json"), JSON.stringify(settings));
    await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
    assert.equal(fixture.bodies.length, 1);
    const state = JSON.parse(
      readFileSync(join(l.dataDir, "sessions", `${l.sessionId}.json`), "utf8"),
    ) as { lastHintKey: string | null; judgedTokens: number | null };
    assert.deepEqual([state.lastHintKey, state.judgedTokens], [null, null]);
    const row = await runCli(["status-line"], { lab: l, stdin: statusPayload(l) });
    assert.ok(!row.stdout.includes(HINT));
  });
}

test("the judge sees the person's own words, not Grok's prompt envelopes", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  const body = JSON.parse(fixture.bodies[0] ?? "{}") as {
    state: { userConstraints: { text: string }[]; savedArtifacts: string[] };
  };
  assert.deepEqual(
    body.state.userConstraints.map((entry) => entry.text),
    ["Fix the parser bug one, run the tests, and commit."],
  );
  assert.deepEqual(body.state.savedArtifacts, ["/repo/src/parser-one.ts"]);
});

test("a judgment below the floor leaves the row without a hint", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  fixture.verdict = { finished: 0.2, handsOn: 0.2 };
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  const row = await runCli(["status-line"], { lab: l, stdin: statusPayload(l) });
  assert.ok(!row.stdout.includes(HINT));
  assert.match(row.stdout, /project │ Grok 4\.6/);
});

test("after a judgment below the floor, re-ask waits for 20k more tokens or 3 exchanges that add 5k", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  // 0.6 x (0.5 + 0.5 x 0.6) = 0.48, under every floor this test reaches.
  fixture.verdict = { finished: 0.6, handsOn: 0.6 };
  const turn = async (marker: string, tokens: number) => {
    writeHistory(l, workedHistory(marker));
    writeSignals(l, tokens);
    await runCli(["hook", "stop"], {
      lab: l,
      stdin: stopPayload(l, { promptId: `prompt-${marker}` }),
      env: keyed(fixture),
    });
  };
  await turn("one", 150000);
  assert.equal(fixture.bodies.length, 1);
  await turn("two", 169999);
  await turn("three", 169999);
  assert.equal(fixture.bodies.length, 1);
  await turn("four", 170000);
  assert.equal(fixture.bodies.length, 2);
  await turn("five", 170000);
  await turn("six", 170000);
  assert.equal(fixture.bodies.length, 2);
  await turn("seven", 174999);
  assert.equal(fixture.bodies.length, 2);
  await turn("eight", 175000);
  assert.equal(fixture.bodies.length, 3);
});

test("no TypeSafe key means no request at all", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  const stop = await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l),
    env: { COMPACT_ADVISER_TEST_ENDPOINT: fixture.url },
  });
  assert.equal(stop.code, 0);
  assert.equal(fixture.bodies.length, 0);
});

test("a cwd .env supplies the key when the environment does not", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  writeFileSync(join(l.cwd, ".env"), "TYPESAFE_API_KEY=tsk-from-dotenv\n");
  await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l),
    env: { COMPACT_ADVISER_TEST_ENDPOINT: fixture.url },
  });
  assert.equal(fixture.bodies.length, 1);
});

test("mode off asks nothing and clears a hint already earned", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.ok(
    (await runCli(["status-line"], { lab: l, stdin: statusPayload(l) })).stdout.includes(HINT),
  );

  await runCli(["mode", "off"], { lab: l });
  await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l, { promptId: "prompt-2" }),
    env: keyed(fixture),
  });
  assert.equal(fixture.bodies.length, 1);
  const row = await runCli(["status-line"], { lab: l, stdin: statusPayload(l) });
  assert.ok(!row.stdout.includes(HINT));
});

test("a subagent's stop and the session-end fire are not checkpoints", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  for (const patch of [
    { subagentType: "explore" },
    { reason: "channel_closed" },
    { stopHookActive: true },
  ]) {
    const stop = await runCli(["hook", "stop"], {
      lab: l,
      stdin: stopPayload(l, patch),
      env: keyed(fixture),
    });
    assert.equal(stop.code, 0);
  }
  assert.equal(fixture.bodies.length, 0);
});

test("a context below the minimum is never judged", async (t) => {
  const { l, fixture } = await judgeTurn(t, { tokens: 30000 });
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.equal(fixture.bodies.length, 0);

  await runCli(["threshold", "25000"], { lab: l });
  await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l, { promptId: "prompt-2" }),
    env: keyed(fixture),
  });
  assert.equal(fixture.bodies.length, 1);
});

test("an unchanged checkpoint is judged once; new work is judged again", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  // A later turn that added nothing the judge can see: same answer, same last ask.
  await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l, { promptId: "prompt-2" }),
    env: keyed(fixture),
  });
  assert.equal(fixture.bodies.length, 1);

  writeHistory(l, [...workedHistory("one"), ...workedHistory("two").slice(1)]);
  await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l, { promptId: "prompt-3" }),
    env: keyed(fixture),
  });
  assert.equal(fixture.bodies.length, 2);
});

test("a compaction retires the hint and holds the next judgments", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.ok(
    (await runCli(["status-line"], { lab: l, stdin: statusPayload(l) })).stdout.includes(HINT),
  );

  await runCli(["hook", "compact"], {
    lab: l,
    stdin: JSON.stringify({
      hook_event_name: "PostCompact",
      sessionId: l.sessionId,
      trigger: "auto",
    }),
  });
  const row = await runCli(["status-line"], { lab: l, stdin: statusPayload(l) });
  assert.ok(!row.stdout.includes(HINT));

  writeHistory(l, [...workedHistory("one"), ...workedHistory("two").slice(1)]);
  await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l, { promptId: "prompt-2" }),
    env: keyed(fixture),
  });
  assert.equal(fixture.bodies.length, 1, "post-compaction cooldown holds the next checkpoint");
  assert.match((await runCli(["status"], { lab: l })).stdout, /Waiting for 20k new tokens/);
});

test("the next prompt retires the hint", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  await runCli(["hook", "prompt"], {
    lab: l,
    stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", sessionId: l.sessionId }),
  });
  const row = await runCli(["status-line"], { lab: l, stdin: statusPayload(l) });
  assert.ok(!row.stdout.includes(HINT));
});

test("a turn that started after the hint hides it even before the prompt hook lands", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  const row = await runCli(["status-line"], {
    lab: l,
    stdin: statusPayload(l, { prompt_id: "prompt-2" }),
  });
  assert.ok(!row.stdout.includes(HINT));
});

test("dismiss and snooze take the hint away and hold the next checkpoints", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.match((await runCli(["dismiss"], { lab: l })).stdout, /dismissed/i);
  assert.ok(
    !(await runCli(["status-line"], { lab: l, stdin: statusPayload(l) })).stdout.includes(HINT),
  );

  assert.match((await runCli(["snooze"], { lab: l })).stdout, /snoozed/i);
  writeHistory(l, [...workedHistory("one"), ...workedHistory("two").slice(1)]);
  await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l, { promptId: "prompt-2" }),
    env: keyed(fixture),
  });
  assert.equal(fixture.bodies.length, 1);
  assert.match((await runCli(["status"], { lab: l })).stdout, /Snoozed/);
});

test("a refused judgment backs off, reports its kind, and never hints", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  fixture.status = 401;
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  const row = await runCli(["status-line"], { lab: l, stdin: statusPayload(l) });
  assert.ok(!row.stdout.includes(HINT));
  const status = await runCli(["status"], { lab: l });
  assert.match(status.stdout, /Last TypeSafe outcome: authentication/);
  assert.match(status.stdout, /TypeSafe backoff/);
});

test("request logging writes the request and the outcome, and never the key", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["log", "on"], { lab: l });
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  const path = join(l.dataDir, `compact-adviser-requests-${l.sessionId}.jsonl`);
  const lines = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line: { kind: string }) => line.kind),
    ["request", "response"],
  );
  assert.equal(lines[0].id, lines[1].id);
  assert.equal(lines[1].qualifies, true);
  assert.ok(!readFileSync(path, "utf8").includes("tsk-test-key"));
});

test("session start writes launchers that resolve the currently installed plugin", async (t) => {
  const l = lab(t);
  await runCli(["hook", "session-start"], {
    lab: l,
    stdin: JSON.stringify({ hook_event_name: "SessionStart", sessionId: l.sessionId }),
  });
  for (const name of ["adviser.sh", "status-line.sh"]) {
    assert.ok(existsSync(join(l.dataDir, name)), `${name} written`);
  }
  const failed = await runLauncher(l);
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /could not find the installed plugin/);

  const viaRoot = await runLauncher(l, [], { env: { GROK_PLUGIN_ROOT: PACKAGE_ROOT } });
  assert.equal(viaRoot.code, 0);
  assert.match(viaRoot.stdout, /compact-adviser \(Grok\)/);
});

test("install registers the same handlers the plugin ships, through the stable launcher", async (t) => {
  const l = lab(t);
  const installed = await runCli(["install"], { lab: l });
  assert.match(installed.stdout, /Registered the compact-adviser hooks/);
  // The person still has to opt the status row in themselves; say so at install time.
  assert.match(installed.stdout, /\[ui\.status_line\]/);

  const written = JSON.parse(readFileSync(join(l.home, "hooks", "compact-adviser.json"), "utf8"));
  const shipped = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "hooks", "hooks.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(written.hooks), Object.keys(shipped.hooks));
  const launcher = join(l.dataDir, "adviser.sh");
  for (const [event, groups] of Object.entries(written.hooks) as [
    string,
    [{ hooks: [{ command: string }] }],
  ][]) {
    const command = groups[0].hooks[0].command;
    assert.ok(command.includes(launcher), `${event} runs the stable launcher`);
    assert.ok(!command.includes("GROK_PLUGIN_ROOT"), `${event} needs no plugin environment`);
  }
  const help = await runLauncher(l, [], { env: { GROK_PLUGIN_ROOT: PACKAGE_ROOT } });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /compact-adviser \(Grok\)/);
});

test("install quotes hook and status-line commands so the shell keeps the path", async (t) => {
  const spaced = mkdtempSync(join(tmpdir(), "compact adviser $home-"));
  t.after(() => rmSync(spaced, { recursive: true, force: true }));
  const l = lab(t);
  const installed = await runCli(["install"], { lab: l, env: { GROK_HOME: spaced } });
  const line = installed.stdout.split("\n").find((row) => row.startsWith("command = "));
  assert.ok(line, "install printed a status-line command");
  const statusCommand = JSON.parse(line.slice("command = ".length)) as string;
  const row = await runShell(statusCommand, {
    lab: l,
    stdin: statusPayload(l),
    env: { GROK_HOME: spaced, GROK_PLUGIN_ROOT: PACKAGE_ROOT },
  });
  assert.equal(row.code, 0, row.stderr);
  assert.match(row.stdout, /project/);
  assert.ok(installed.stdout.includes(join(spaced, "config.toml")));

  const written = JSON.parse(readFileSync(join(spaced, "hooks", "compact-adviser.json"), "utf8"));
  const hook = written.hooks.Stop[0].hooks[0].command as string;
  const stop = await runShell(hook, {
    lab: l,
    stdin: stopPayload(l),
    env: { GROK_HOME: spaced, GROK_PLUGIN_ROOT: PACKAGE_ROOT },
  });
  assert.equal(stop.code, 0, stop.stderr);
});

test("a Stop that starts after the same turn was already handled is skipped", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  const [first, second] = await Promise.all([
    runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) }),
    runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) }),
  ]);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  const asked = fixture.bodies.length;
  assert.ok(asked === 1 || asked === 2, `asked ${asked} times`);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.equal(fixture.bodies.length, asked);
});

test("a malformed transcript line is not judged", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  const path = join(l.sessionDir, "chat_history.jsonl");
  writeFileSync(path, `${readFileSync(path, "utf8")}not json at all\n`);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.equal(fixture.bodies.length, 0);
  const row = await runCli(["status-line"], { lab: l, stdin: statusPayload(l) });
  assert.ok(!row.stdout.includes(HINT));
});

test("a TypeSafe timeout aborts the in-flight request and stays silent", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  fixture.hang = true;
  const stop = await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l),
    env: keyed(fixture),
  });
  assert.equal(stop.code, 0);
  assert.equal(stop.stdout, "");
  assert.equal(fixture.bodies.length, 1);
  const row = await runCli(["status-line"], { lab: l, stdin: statusPayload(l) });
  assert.ok(!row.stdout.includes(HINT));
  assert.match((await runCli(["status"], { lab: l })).stdout, /Last TypeSafe outcome: timeout/);
});

test("an oversized TypeSafe response is refused without a hint", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  fixture.oversize = true;
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.equal(fixture.bodies.length, 1);
  const row = await runCli(["status-line"], { lab: l, stdin: statusPayload(l) });
  assert.ok(!row.stdout.includes(HINT));
  assert.match((await runCli(["status"], { lab: l })).stdout, /Last TypeSafe outcome: response/);
});

test("setup, doctor, items, and hint are not commands", async (t) => {
  const l = lab(t);
  for (const command of ["setup", "doctor", "items", "hint"]) {
    const result = await runCli([command], { lab: l });
    assert.equal(result.code, 1, command);
    assert.match(result.stderr, /Unknown command/);
    assert.ok(!result.stdout.includes(HINT));
  }
});

test("an unreadable settings file stops the product instead of guessing", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["mode", "hint"], { lab: l });
  writeFileSync(join(l.dataDir, "settings.json"), '{"version":1,"mode":"sometimes"}');
  const stop = await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l),
    env: keyed(fixture),
  });
  assert.equal(stop.code, 0);
  assert.equal(fixture.bodies.length, 0);
  const status = await runCli(["status"], { lab: l });
  assert.equal(status.code, 1);
  assert.match(status.stderr, /Cannot read the compact-adviser mode setting/);
});

test("a corrupt session state file does not bypass snooze or post-compaction cooldown", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.equal(fixture.bodies.length, 1);
  await runCli(["snooze"], { lab: l });
  writeFileSync(join(l.dataDir, "sessions", `${l.sessionId}.json`), "not json at all\n");
  writeHistory(l, [...workedHistory("one"), ...workedHistory("two").slice(1)]);
  await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l, { promptId: "prompt-2" }),
    env: keyed(fixture),
  });
  assert.equal(fixture.bodies.length, 1);
  assert.ok(
    !(await runCli(["status-line"], { lab: l, stdin: statusPayload(l) })).stdout.includes(HINT),
  );

  const compacted = await judgeTurn(t);
  await runCli(["hook", "stop"], {
    lab: compacted.l,
    stdin: stopPayload(compacted.l),
    env: keyed(compacted.fixture),
  });
  await runCli(["hook", "compact"], {
    lab: compacted.l,
    stdin: JSON.stringify({
      hook_event_name: "PostCompact",
      sessionId: compacted.l.sessionId,
      trigger: "auto",
    }),
  });
  writeFileSync(
    join(compacted.l.dataDir, "sessions", `${compacted.l.sessionId}.json`),
    "not json at all\n",
  );
  writeHistory(compacted.l, [...workedHistory("one"), ...workedHistory("two").slice(1)]);
  await runCli(["hook", "stop"], {
    lab: compacted.l,
    stdin: stopPayload(compacted.l, { promptId: "prompt-2" }),
    env: keyed(compacted.fixture),
  });
  assert.equal(compacted.fixture.bodies.length, 1);
  assert.ok(
    !(
      await runCli(["status-line"], {
        lab: compacted.l,
        stdin: statusPayload(compacted.l),
      })
    ).stdout.includes(HINT),
  );
});

test("a settings path that is not a file does not resume judging", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["mode", "off"], { lab: l });
  const path = join(l.dataDir, "settings.json");
  rmSync(path);
  mkdirSync(path);
  const stop = await runCli(["hook", "stop"], {
    lab: l,
    stdin: stopPayload(l),
    env: keyed(fixture),
  });
  assert.equal(stop.code, 0);
  assert.equal(fixture.bodies.length, 0);
  const status = await runCli(["status"], { lab: l });
  assert.equal(status.code, 1);
  assert.match(status.stderr, /Cannot read the compact-adviser settings file/);
});

test("COMPACT_ADVISER_DISABLE takes every product action out of the session", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  const env = { ...keyed(fixture), COMPACT_ADVISER_DISABLE: "1" };
  const stop = await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env });
  assert.equal(stop.code, 0);
  assert.equal(stop.stdout, "");
  assert.equal(fixture.bodies.length, 0);

  const row = await runCli(["status-line"], { lab: l, stdin: statusPayload(l), env });
  assert.ok(!row.stdout.includes(HINT));
  assert.match(row.stdout, /project │ Grok 4\.6/);

  const status = await runCli(["status"], { lab: l, env });
  assert.equal(status.code, 1);
  assert.match(status.stderr, /COMPACT_ADVISER_DISABLE/);

  const mode = await runCli(["mode", "off"], { lab: l, env });
  assert.equal(mode.code, 1);

  const installed = await runCli(["install"], { lab: l, env });
  assert.equal(installed.code, 1);
  assert.equal(existsSync(join(l.home, "hooks", "compact-adviser.json")), false);
});

test("COMPACT_ADVISER_DISABLE hides an already earned hint", async (t) => {
  const { l, fixture } = await judgeTurn(t);
  await runCli(["hook", "stop"], { lab: l, stdin: stopPayload(l), env: keyed(fixture) });
  assert.ok(
    (await runCli(["status-line"], { lab: l, stdin: statusPayload(l) })).stdout.includes(HINT),
  );
  const row = await runCli(["status-line"], {
    lab: l,
    stdin: statusPayload(l),
    env: { COMPACT_ADVISER_DISABLE: "1" },
  });
  assert.ok(!row.stdout.includes(HINT));
  assert.match(row.stdout, /project │ Grok 4\.6/);
});

test("install reports a launcher write failure instead of succeeding", async (t) => {
  const l = lab(t);
  writeFileSync(l.dataDir, "not a directory");
  const installed = await runCli(["install"], { lab: l });
  assert.notEqual(installed.code, 0);
  assert.equal(existsSync(join(l.home, "hooks", "compact-adviser.json")), false);
});

test("session start stays silent when launchers cannot be written", async (t) => {
  const l = lab(t);
  writeFileSync(l.dataDir, "not a directory");
  const start = await runCli(["hook", "session-start"], {
    lab: l,
    stdin: JSON.stringify({ hook_event_name: "SessionStart", sessionId: l.sessionId }),
  });
  assert.equal(start.code, 0);
  assert.equal(start.stdout, "");
});
