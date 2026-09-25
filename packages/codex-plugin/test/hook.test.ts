// One completed Codex turn, end to end through the hook's own entry point: the local gates,
// the TypeSafe request, the hint, and what each failure leaves behind.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { ConfigStore } from "../src/config.ts";
import { type Environment, HINT, type HookPayload, handle } from "../src/hook.ts";
import { requestLogPath } from "../src/log.ts";
import { adviserRoot } from "../src/paths.ts";
import { SessionStore } from "../src/store.ts";
import {
  assistantMessage,
  environment,
  fakeTypesafe,
  jevAnswer,
  type Lab,
  makeLab,
  sessionMeta,
  settledRollout,
  TYPESAFE_KEY,
  tokenCount,
  toolCall,
  toolOutput,
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

test("an exec program's shell writes reach the saved artifacts end to end", async () => {
  await withLab(async (lab) => {
    // Codex records shell work as a custom_tool_call named `exec` whose input is a JavaScript
    // program calling tools.exec_command; the shell line sits in its `cmd` field.
    const exec = (cmd: string, id: string) =>
      toolCall(
        "exec",
        `const r = await tools.exec_command({"cmd":${JSON.stringify(cmd)},"workdir":"${lab.cwd}","yield_time_ms":10000,"max_output_tokens":20000}); text(r.output);\n`,
        id,
      );
    const bulk = "Implementation notes for the parser module. ".repeat(2600);
    writeRollout(lab.transcript, [
      sessionMeta(),
      userMessage("Generate the table, then report."),
      exec("sed -n '1,240p' src/parser.ts", "call_1"),
      toolOutput(`the file contents\n${bulk}`, "call_1"),
      exec("node gen.js > src/table.ts", "call_2"),
      toolOutput("done", "call_2"),
      exec("cat in.txt | tee copy.txt", "call_3"),
      toolOutput("done", "call_3"),
      assistantMessage("Done: the table is generated and committed."),
      tokenCount(70000),
    ]);
    const typesafe = fakeTypesafe();
    await handle(stop(lab), environment(lab, { fetch: typesafe.fetch }));

    const body = typesafe.requests[0]?.body as { state: { savedArtifacts: string[] } };
    assert.deepEqual(body.state.savedArtifacts, ["src/table.ts", "copy.txt"]);
  });
});

test("a stored profile reaches the hook request and gate", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    const root = adviserRoot({ CODEX_HOME: lab.home });
    new ConfigStore(root).update({
      profile: JSON.stringify({ version: 1, coordinationWeight: 1, floors: [[0, 1]] }),
      logRequests: true,
    });
    const typesafe = fakeTypesafe();
    assert.deepEqual(await handle(stop(lab), environment(lab, { fetch: typesafe.fetch })), {});
    assert.equal(typesafe.requests.length, 1);
    const rows = readFileSync(requestLogPath(root, "s1"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows[1].floor, 1);
    assert.equal(rows[1].qualifies, false);
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

test("after a judgment below the floor, re-ask waits for 20k more tokens or 3 exchanges that add 5k", async () => {
  await withLab(async (lab) => {
    // 0.6 x (0.5 + 0.5 x 0.6) = 0.48, under every floor this test reaches.
    const typesafe = fakeTypesafe(() => ({ body: jevAnswer(0.6, 0.6) }));
    const environment_ = environment(lab, { fetch: typesafe.fetch });
    const turn = async (ask: string, tokens: number) => {
      writeRollout(lab.transcript, [
        ...settledRollout({ tokens: 70000 }),
        userMessage(ask),
        assistantMessage(`Done: ${ask}.`),
        tokenCount(tokens),
      ]);
      return handle(stop(lab), environment_);
    };
    await turn("first", 70000);
    assert.equal(typesafe.requests.length, 1);
    await turn("second", 89999);
    await turn("third", 89999);
    assert.equal(typesafe.requests.length, 1);
    await turn("fourth", 90000);
    assert.equal(typesafe.requests.length, 2);
    await turn("fifth", 90000);
    await turn("sixth", 90000);
    assert.equal(typesafe.requests.length, 2);
    await turn("seventh", 94999);
    assert.equal(typesafe.requests.length, 2);
    await turn("eighth", 95000);
    assert.equal(typesafe.requests.length, 3);
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
    {
      name: "originator-less source:cli is not the TUI",
      records: [
        { type: "session_meta", payload: { session_id: "s1", source: "cli" } },
        ...settledRollout().slice(1),
      ],
    },
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

test("a TypeSafe timeout aborts the in-flight request and stays silent", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    let aborted = false;
    const fetch = (async (_url: string | URL, init?: RequestInit) => {
      return new Response(
        new ReadableStream({
          start(controller) {
            const fail = () => {
              aborted = true;
              controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
            };
            const signal = init?.signal;
            if (signal?.aborted) fail();
            else signal?.addEventListener("abort", fail, { once: true });
          },
        }),
        { status: 200 },
      );
    }) as Environment["fetch"];

    const output = await handle(stop(lab), environment(lab, { fetch }));

    assert.deepEqual(output, {}, "a timed-out judgment never hints");
    assert.equal(aborted, true);
    const store = new SessionStore(adviserRoot({ CODEX_HOME: lab.home }));
    assert.equal(store.read("s1", 0).state.failures, 1);
  });
});

test("COMPACT_ADVISER_DISABLE blocks TypeSafe and the hint", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    const typesafe = fakeTypesafe();
    const base = environment(lab, { fetch: typesafe.fetch });
    const output = await handle(stop(lab), {
      ...base,
      env: { ...base.env, COMPACT_ADVISER_DISABLE: "1" },
    });
    assert.deepEqual(output, {});
    assert.equal(typesafe.requests.length, 0);
  });
});

test("COMPACT_ADVISER_DISABLE leaves the session alone when it is falsy", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    const typesafe = fakeTypesafe();
    const base = environment(lab, { fetch: typesafe.fetch });
    const output = await handle(stop(lab), {
      ...base,
      env: { ...base.env, COMPACT_ADVISER_DISABLE: "0" },
    });
    assert.deepEqual(output, { systemMessage: HINT });
    assert.equal(typesafe.requests.length, 1);
  });
});

test("a concurrent off after TypeSafe returns is honoured and does not hint", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    const root = adviserRoot({ CODEX_HOME: lab.home });
    const typesafe = fakeTypesafe();
    const fetch: Environment["fetch"] = async (url, init) => {
      new ConfigStore(root).update({ mode: "off" });
      return typesafe.fetch(url, init);
    };

    const output = await handle(stop(lab), environment(lab, { fetch }));

    assert.deepEqual(output, {});
    assert.equal(typesafe.requests.length, 1);
    assert.equal(new SessionStore(root).read("s1", 0).state.lastHintKey, null);
  });
});

test("a concurrent threshold increase after TypeSafe returns suppresses the hint", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    const root = adviserRoot({ CODEX_HOME: lab.home });
    const typesafe = fakeTypesafe();
    const fetch: Environment["fetch"] = async (url, init) => {
      new ConfigStore(root).update({ minContextTokens: 100000 });
      return typesafe.fetch(url, init);
    };

    const output = await handle(stop(lab), environment(lab, { fetch }));

    assert.deepEqual(output, {});
    assert.equal(typesafe.requests.length, 1);
    assert.equal(new SessionStore(root).read("s1", 0).state.lastHintKey, null);
  });
});

test("a below-floor judgment discarded by a concurrent settings change does not start the re-ask wait", async () => {
  await withLab(async (lab) => {
    writeRollout(lab.transcript, settledRollout());
    const root = adviserRoot({ CODEX_HOME: lab.home });
    const typesafe = fakeTypesafe(() => ({ body: jevAnswer(0.6, 0.6) }));
    const fetch: Environment["fetch"] = async (url, init) => {
      new ConfigStore(root).update({ minContextTokens: 100000 });
      return typesafe.fetch(url, init);
    };
    await handle(stop(lab), environment(lab, { fetch }));
    assert.equal(typesafe.requests.length, 1);
    const state = new SessionStore(root).read("s1", 0).state;
    assert.deepEqual([state.judgedTokens, state.judgedAt], [null, null]);
  });
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
    await handle({ hook_event_name: "PreCompact", session_id: "s1" }, environment_);
    assert.equal(store.read("s1", 0).state.compacted, false);
    assert.ok(store.read("s1", 0).state.completed > 0);

    await handle({ hook_event_name: "PostCompact", session_id: "s1" }, environment_);
    const state = store.read("s1", 0).state;
    assert.equal(state.compacted, true);
    assert.equal(state.completed, 0);
    assert.equal(state.lastHintKey, null);

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
