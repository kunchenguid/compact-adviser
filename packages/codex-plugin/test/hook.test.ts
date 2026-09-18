// One completed Codex turn, end to end through the hook's own entry point: the local gates,
// the TypeSafe request, the hint, and what each failure leaves behind.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { ConfigStore } from "../src/config.ts";
import { HINT, type HookPayload, handle } from "../src/hook.ts";
import { requestLogPath } from "../src/log.ts";
import { adviserRoot } from "../src/paths.ts";
import { SessionStore } from "../src/store.ts";
import {
  assistantMessage,
  environment,
  fakeTypesafe,
  type Lab,
  makeLab,
  sessionMeta,
  settledRollout,
  TYPESAFE_KEY,
  tokenCount,
  userMessage,
  writeRollout,
} from "./support.ts";

function stop(lab: Lab, overrides: Partial<HookPayload> = {}): HookPayload {
  return {
    hook_event_name: "Stop",
    session_id: "s1",
    transcript_path: lab.transcript,
    cwd: lab.cwd,
    last_assistant_message: "Done: the parser is implemented.",
    stop_hook_active: false,
    ...overrides,
  };
}

async function withLab(body: (lab: Lab) => Promise<void>): Promise<void> {
  const lab = makeLab();
  try {
    await body(lab);
  } finally {
    lab.cleanup();
  }
}

test("a settled, large-enough checkpoint is judged once and hints", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    const typesafe = fakeTypesafe();
    const output = await handle(stop(lab), environment(lab, { fetch: typesafe.fetch }));

    assert.deepEqual(output, { systemMessage: HINT });
    assert.equal(typesafe.requests.length, 1);
    assert.equal(typesafe.requests[0]?.authorization, `Bearer ${TYPESAFE_KEY}`);
    assert.equal(typesafe.requests[0]?.url, "https://api.typesafe.ai/v1/systemone");
    const body = typesafe.requests[0]?.body as {
      model: string;
      state: { savedArtifacts: string[] };
    };
    assert.equal(body.model, "jev-latest");
    assert.deepEqual(body.state.savedArtifacts, ["src/parser.ts"]);
    assert.ok(!JSON.stringify(body).includes(TYPESAFE_KEY), "the key never travels in the body");
  });
});

test("the same checkpoint is never judged twice", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    const typesafe = fakeTypesafe();
    const environment_ = environment(lab, { fetch: typesafe.fetch });

    assert.deepEqual(await handle(stop(lab), environment_), { systemMessage: HINT });
    assert.deepEqual(await handle(stop(lab), environment_), {});
    assert.equal(typesafe.requests.length, 1);
  });
});

test("a materially different next checkpoint is judged again straight away", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    const typesafe = fakeTypesafe();
    const environment_ = environment(lab, { fetch: typesafe.fetch });
    assert.deepEqual(await handle(stop(lab), environment_), { systemMessage: HINT });

    writeRollout(lab.transcript, [
      ...settledRollout(),
      userMessage("Now run the tests."),
      assistantMessage("Done: 12 of 12 tests pass and it is committed."),
      tokenCount(80000),
    ]);
    assert.deepEqual(await handle(stop(lab), environment_), { systemMessage: HINT });
    assert.equal(typesafe.requests.length, 2);
  });
});

test("a judgment below the floor settles the session without a hint", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout({ tokens: 40000 }));
    // 40,000 of 200,000 is 20% used, a 0.85 floor; this judgment composes to 0.48.
    const typesafe = fakeTypesafe(() => ({
      body: {
        model: "jev-1.13.0",
        answers: {
          done: {
            type: "choice",
            choice: "finished",
            confidence: 0.6,
            probabilities: { finished: 0.6, not_finished: 0.3, unclear: 0.1 },
          },
          shape: {
            type: "choice",
            choice: "hands_on",
            confidence: 0.6,
            probabilities: { hands_on: 0.6, coordinating: 0.3, unclear: 0.1 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }));
    assert.deepEqual(await handle(stop(lab), environment(lab, { fetch: typesafe.fetch })), {});
    assert.equal(typesafe.requests.length, 1);
    const store = new SessionStore(adviserRoot({ CODEX_HOME: lab.home }));
    assert.equal(store.read("s1", 0).state.lastHintKey, null);
  });
});

test("the local gates keep a checkpoint away from TypeSafe", async () => {
  const cases: {
    name: string;
    records?: unknown[];
    payload?: Partial<HookPayload>;
    settings?: Record<string, unknown>;
    env?: Record<string, string | undefined>;
  }[] = [
    { name: "mode off", settings: { mode: "off" } },
    { name: "minimum not reached", settings: { minContextTokens: 200000 } },
    { name: "no key at all", env: { TYPESAFE_API_KEY: undefined } },
    { name: "no usage in the transcript", records: [sessionMeta(), assistantMessage("done")] },
    { name: "not the interactive TUI", records: settledRollout({ originator: "codex_exec" }) },
    { name: "no final answer", payload: { last_assistant_message: "   " } },
    { name: "re-entered stop", payload: { stop_hook_active: true } },
    { name: "no transcript path", payload: { transcript_path: undefined } },
    {
      name: "conversation still small",
      records: [sessionMeta(), assistantMessage("done"), tokenCount(70000)],
    },
  ];
  for (const c of cases) {
    await withLab(async (lab) => {
      writeRollout(lab.transcript, c.records ?? settledRollout());
      if (c.settings) new ConfigStore(adviserRoot({ CODEX_HOME: lab.home })).update(c.settings);
      const typesafe = fakeTypesafe();
      const base = environment(lab, { fetch: typesafe.fetch });
      const output = await handle(stop(lab, c.payload), {
        ...base,
        env: { ...base.env, ...c.env },
      });
      assert.deepEqual(output, {}, `${c.name}: expected no hint`);
      assert.equal(typesafe.requests.length, 0, `${c.name}: expected no TypeSafe request`);
    });
  }
});

test("a TypeSafe failure backs off and stays silent", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    const typesafe = fakeTypesafe(() => ({ status: 500 }));
    const now = 5_000_000;
    const output = await handle(
      stop(lab),
      environment(lab, { fetch: typesafe.fetch, now: () => now }),
    );

    assert.deepEqual(output, {}, "a failed judgment never hints");
    const store = new SessionStore(adviserRoot({ CODEX_HOME: lab.home }));
    const state = store.read("s1", now).state;
    assert.equal(state.failures, 1);
    assert.ok(state.retryAfter > now, "the next checkpoint waits");
  });
});

test("a key from the working directory's .env is used and never logged", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    writeFileSync(`${lab.cwd}/.env`, `TYPESAFE_API_KEY=tsk-from-dotenv\n`);
    const root = adviserRoot({ CODEX_HOME: lab.home });
    new ConfigStore(root).update({ logRequests: true });
    const typesafe = fakeTypesafe();
    const base = environment(lab, { fetch: typesafe.fetch });

    const output = await handle(stop(lab), {
      ...base,
      env: { CODEX_HOME: lab.home },
    });

    assert.deepEqual(output, { systemMessage: HINT });
    assert.equal(typesafe.requests[0]?.authorization, "Bearer tsk-from-dotenv");
    const log = readFileSync(requestLogPath(root, "s1"), "utf8");
    const lines = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => line.kind),
      ["request", "response"],
    );
    assert.equal(lines[0].id, lines[1].id);
    assert.equal(lines[1].answers.done.choice, "finished");
    assert.equal(lines[1].qualifies, true);
    assert.equal(typeof lines[1].floor, "number");
    assert.ok(!log.includes("tsk-from-dotenv"), "the key never reaches the request log");
  });
});

test("a failed judgment is logged as a sanitized error kind only", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    const root = adviserRoot({ CODEX_HOME: lab.home });
    new ConfigStore(root).update({ logRequests: true });
    const typesafe = fakeTypesafe(() => ({ status: 401 }));

    await handle(stop(lab), environment(lab, { fetch: typesafe.fetch }));

    const lines = readFileSync(requestLogPath(root, "s1"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines.at(-1).error, { kind: "authentication" });
  });
});

test("compaction resets the session, and the next checkpoint waits for the new baseline", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    const typesafe = fakeTypesafe();
    const environment_ = environment(lab, { fetch: typesafe.fetch });
    const store = new SessionStore(adviserRoot({ CODEX_HOME: lab.home }));

    await handle(stop(lab), environment_);
    for (const event of ["PreCompact", "PostCompact"]) {
      await handle({ hook_event_name: event, session_id: "s1" }, environment_);
      const state = store.read("s1", 0).state;
      assert.equal(state.compacted, true, event);
      assert.equal(state.completed, 0, event);
      assert.equal(state.lastHintKey, null, event);
    }

    writeRollout(lab.transcript, [
      ...settledRollout(),
      userMessage("Next step."),
      assistantMessage("Done and committed."),
      tokenCount(71000),
    ]);
    assert.deepEqual(await handle(stop(lab), environment_), {}, "the post-compaction wait holds");
    assert.equal(typesafe.requests.length, 1);
  });
});

test("SessionStart resumed from a compaction resets, and an ordinary one does not", async () => {
  await withLab(async (lab) => {
    const environment_ = environment(lab);
    const store = new SessionStore(adviserRoot({ CODEX_HOME: lab.home }));
    store.write("s1", { ...store.read("s1", 0).state, completed: 7 });

    await handle(
      { hook_event_name: "SessionStart", session_id: "s1", source: "startup" },
      environment_,
    );
    assert.equal(store.read("s1", 0).state.completed, 7);

    await handle(
      { hook_event_name: "SessionStart", session_id: "s1", source: "compact" },
      environment_,
    );
    assert.equal(store.read("s1", 0).state.completed, 0);
    assert.equal(store.read("s1", 0).state.compacted, true);
  });
});

test("SessionStart prunes session records the product stopped caring about", async () => {
  await withLab(async (lab) => {
    const store = new SessionStore(adviserRoot({ CODEX_HOME: lab.home }));
    const now = 90 * 24 * 60 * 60 * 1000;
    store.write("old", { ...store.read("old", 0).state, updatedAt: 0 });
    store.write("fresh", { ...store.read("fresh", now).state, updatedAt: now });

    await handle(
      { hook_event_name: "SessionStart", session_id: "fresh", source: "startup" },
      environment(lab, { now: () => now }),
    );

    assert.equal(store.latest()?.id, "fresh");
    assert.equal(store.read("old", now).state.completed, 0);
    assert.ok(!store.read("old", now).state.compacted, "the stale record is gone, not resurrected");
  });
});

test("an unknown hook event does nothing at all", async () => {
  await withLab(async (lab) => {
    assert.deepEqual(
      await handle({ hook_event_name: "PreToolUse", session_id: "s1" }, environment(lab)),
      {},
    );
  });
});
