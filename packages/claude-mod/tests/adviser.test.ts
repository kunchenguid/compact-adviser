// compact-adviser's hooks module under `claude plugin test`: activation, the turn-end
// gates, hint and automatic outcomes, cooldowns across compactions, the commands, and
// the settings pane. The world beneath the plugin is mocked in ./support.ts.
import { describe, type Engine, expect, test } from "claude-code/testing";
import {
  JUDGE_DISABLED_NETWORK_MESSAGE,
  judgeErrorMessage,
  parseJudgment,
  score,
} from "../lib/judge.ts";
import { RECENT_TAIL_MESSAGES } from "../lib/snapshot.ts";
import {
  answered,
  commandRun,
  elements,
  interactiveStart,
  jevAnswer,
  KEY,
  longConversation,
  PLUGIN,
  pane,
  SESSION,
  START,
  text,
  type World,
  world,
} from "./support.ts";

const MESSAGES = [{ role: "user" as const, text: "hello", toolUses: [] }];
const HINT = "Potential session boundary detected. Run /compact to save tokens.";

function lastJsonl(write: { text: string } | undefined) {
  const lines = (write?.text ?? "").trim().split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1) ?? "");
}

/** Drain `$.clock.after(0, …)` plus the async judgment it starts. */
async function drain(w: World) {
  for (let i = 0; i < 50; i++) {
    await w.clock.settle();
    await Promise.resolve();
    await Promise.resolve();
  }
}

async function turnEnd($: Engine, w: World, answer = answered()) {
  await $.turn.complete(answer);
  await drain(w);
}

async function turn($: Engine, w: World, id = "t") {
  await $.turn.start({ turnId: id, origin: { kind: "composer" } } as never);
  await turnEnd($, w);
}

function stored(w: World) {
  return w.store.get(`session:${SESSION}`) as Record<string, unknown>;
}

describe("activation", () => {
  for (const flag of [undefined, "true", "0"]) {
    test(`is inert when CLAUDE_CODE_ENABLE_FUNCTION_HOOKS is ${flag ?? "unset"}`, async ($, on) => {
      const w = world(on, { functionHooks: flag });
      await $.session.start(interactiveStart);
      await turnEnd($, w);
      await $.session.compact({ trigger: "manual", messages: MESSAGES });
      expect(w.journal.commands).toHaveLength(0);
      expect(w.journal.statuses).toHaveLength(0);
      expect(w.journal.toasts).toHaveLength(0);
      expect(w.journal.requests).toHaveLength(0);
      expect(w.journal.usageReads).toBe(0);
      expect(w.journal.messageReads).toBe(0);
    });
  }

  test("registers /compact-adviser and does not pin an ambient status line", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    expect(w.journal.commands).toEqual([PLUGIN]);
    expect(w.journal.statuses.filter((s) => s)).toHaveLength(0);
  });
});

describe("turn-end gates", () => {
  test("a qualifying settled checkpoint shows the hint once, without blocking the turn", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    const result = await $.turn.complete(answered());
    expect(result.text).toBe(answered().answer);
    expect(w.journal.requests).toHaveLength(0);
    await drain(w);
    expect(w.journal.requests).toHaveLength(1);
    const request = w.journal.requests[0] ?? { url: "", headers: {}, body: "" };
    expect(request.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(request.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(request.body.includes(KEY)).toBe(false);
    expect(JSON.parse(request.body).model).toBe("jev-latest");
    expect(w.journal.statuses.at(-1)).toBe(HINT);
    expect(w.journal.toasts).toContain(HINT);
    expect(w.journal.suggestions).toEqual(["/compact"]);
    expect(w.journal.compactions).toHaveLength(0);
    expect(w.journal.fsWrites).toHaveLength(0);
  });

  test("optional request logging writes the TypeSafe body and never the key", async ($, on) => {
    const w = world(on, { logRequests: true });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(w.journal.fsWrites).toHaveLength(2);
    const requestLine = lastJsonl(w.journal.fsWrites[0]);
    const responseLine = lastJsonl(w.journal.fsWrites[1]);
    expect(w.journal.fsWrites[1]?.text.trim().split("\n")).toHaveLength(2);
    expect(requestLine.kind).toBe("request");
    expect(requestLine.body.model).toBe("jev-latest");
    expect(responseLine.kind).toBe("response");
    expect(responseLine.id).toBe(requestLine.id);
    expect(responseLine.answers.done.choice).toBe("finished");
    expect(typeof responseLine.answers.done.probabilities.finished).toBe("number");
    expect(typeof responseLine.answers.shape.probabilities.hands_on).toBe("number");
    expect(responseLine.score).toBe(score(parseJudgment(jevAnswer())));
    expect(responseLine.usage).toBe(0.3);
    expect(typeof responseLine.floor).toBe("number");
    expect(responseLine.qualifies).toBe(true);
    expect(w.journal.fsWrites[0]?.path.endsWith("compact-adviser-requests-session-1.jsonl")).toBe(
      true,
    );
    expect(w.journal.fsWrites.some((write) => write.text.includes(KEY))).toBe(false);
  });

  test("each session writes its own request log file", async ($, on) => {
    const w = world(on, { logRequests: true });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    w.sessionId = "session-2";
    w.messages = longConversation("Please finish the other parser and commit it.");
    await turnEnd($, w);
    const paths = [...new Set(w.journal.fsWrites.map((write) => write.path))];
    expect(paths).toHaveLength(2);
    expect(paths[0]?.endsWith("compact-adviser-requests-session-1.jsonl")).toBe(true);
    expect(paths[1]?.endsWith("compact-adviser-requests-session-2.jsonl")).toBe(true);
  });

  test("a saved key in a settings.json read is absent from the TypeSafe body and request log", async ($, on) => {
    const secret = "tsk-saved-key-must-not-leave";
    const w = world(on, { key: undefined, savedKey: secret, logRequests: true });
    w.messages = [
      ...w.messages,
      {
        role: "assistant",
        text: "Saved notes.",
        toolUses: [
          {
            tool_use_id: "write-notes",
            tool: "Write",
            input: { file_path: `/tmp/notes-${secret}.md` },
            text: "ok",
          },
        ],
      },
      {
        role: "assistant",
        text: "Read the plugin settings.",
        toolUses: [
          {
            tool_use_id: "settings",
            tool: "Read",
            input: { file_path: "/home/fixture/.claude/settings.json" },
            text: JSON.stringify({
              pluginConfigs: {
                "compact-adviser@0.1.0": {
                  options: { mode: "hint", typesafeApiKey: secret },
                },
              },
            }),
          },
        ],
      },
    ];
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    const request = w.journal.requests[0] ?? { url: "", headers: {}, body: "" };
    expect(request.headers.Authorization).toBe(`Bearer ${secret}`);
    expect(request.body.includes(secret)).toBe(false);
    expect(request.body).toContain("hint");
    const logged = w.journal.fsWrites.map((write) => write.text).join("");
    expect(logged.includes(secret)).toBe(false);
    expect(logged.includes("jev-latest")).toBe(true);
  });

  test("a silent no-qualify turn still logs the Jev response", async ($, on) => {
    const answer = jevAnswer({ completed: 0.99, handsOn: 0.01 });
    const w = world(on, { logRequests: true });
    w.respond = async () => ({ status: 200, text: JSON.stringify(answer) });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(w.journal.statuses.includes(HINT)).toBe(false);
    expect(w.journal.fsWrites).toHaveLength(2);
    const responseLine = lastJsonl(w.journal.fsWrites[1]);
    expect(responseLine.kind).toBe("response");
    expect(responseLine.qualifies).toBe(false);
    expect(responseLine.score).toBe(score(parseJudgment(answer)));
    expect(w.journal.fsWrites.some((write) => write.text.includes(KEY))).toBe(false);
  });

  test("a judgment failure logs the error kind without the key", async ($, on) => {
    const w = world(on, { logRequests: true });
    w.respond = async () => ({ status: 429, text: `rate-limit ${KEY}` });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.fsWrites).toHaveLength(2);
    const requestLine = lastJsonl(w.journal.fsWrites[0]);
    const errorLine = lastJsonl(w.journal.fsWrites[1]);
    expect(requestLine.kind).toBe("request");
    expect(errorLine.kind).toBe("error");
    expect(errorLine.id).toBe(requestLine.id);
    expect(errorLine.error).toEqual({ kind: "rate-limit" });
    expect(JSON.stringify(errorLine).includes(KEY)).toBe(false);
    expect(w.journal.fsWrites.some((write) => write.text.includes(KEY))).toBe(false);
  });

  test("the next turn clears the hint without restoring a status strip", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.statuses.at(-1)).toBe(HINT);
    await $.turn.start({ turnId: "t2", origin: { kind: "composer" } } as never);
    expect(w.journal.statuses.at(-1)).toBeUndefined();
  });

  test("below the constant minimum no transcript is read and TypeSafe is not called", async ($, on) => {
    const w = world(on, { minimum: 60001 });
    w.usage.tokens = 60000;
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(0);
    expect(w.journal.messageReads).toBe(0);
    w.rows.set(`${PLUGIN}.minContextTokens`, 60000);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
  });

  test("the minimum is a token count: a 1M window at 4% still qualifies at 40k", async ($, on) => {
    const w = world(on);
    w.usage = { tokens: 40000, window: 1000000, autoCompactThreshold: 967000 };
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
  });

  test("no request without a key, known usage, or in off mode", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    w.usage.tokens = undefined;
    await turnEnd($, w);
    w.usage.tokens = 60000;
    w.rows.set(`${PLUGIN}.mode`, "off");
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(0);
    w.rows.set(`${PLUGIN}.mode`, "hint");
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
  });

  test("legacy sharingConsent false in the plugin store is ignored", async ($, on) => {
    const w = world(on, { consent: { sharingConsent: false, autoAcknowledged: false } });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
  });

  test("an empty key never makes a request", async ($, on) => {
    const w = world(on, { key: "   " });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(0);
  });

  test("cwd .env supplies the key when the host env is empty", async ($, on) => {
    const w = world(on, {
      key: undefined,
      dotenv:
        '# ignore\nOTHER=nope\nTYPESAFE_API_KEY=from-dotenv\ndeclare -x TYPESAFE_API_KEY="from-dotenv-last"\n',
    });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.fsReads.some((path) => path === ".env" || path.endsWith("/.env"))).toBe(true);
    expect(w.journal.requests).toHaveLength(1);
    expect(w.journal.requests[0]?.headers.Authorization).toBe("Bearer from-dotenv-last");
    expect(w.journal.requests[0]?.body.includes("from-dotenv-last")).toBe(false);
  });

  test("a host env key wins over cwd .env", async ($, on) => {
    const w = world(on, { dotenv: "TYPESAFE_API_KEY=from-dotenv\n" });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.fsReads).toEqual([]);
    expect(w.journal.requests).toHaveLength(1);
    expect(w.journal.requests[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(w.journal.requests[0]?.body.includes("from-dotenv")).toBe(false);
  });

  test("a saved menu key is used when env is empty and wins over cwd .env", async ($, on) => {
    const w = world(on, {
      key: undefined,
      savedKey: "from-saved",
      dotenv: "TYPESAFE_API_KEY=from-dotenv\n",
    });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.fsReads).toEqual([]);
    expect(w.journal.requests).toHaveLength(1);
    expect(w.journal.requests[0]?.headers.Authorization).toBe("Bearer from-saved");
    expect(w.journal.requests[0]?.body.includes("from-saved")).toBe(false);
  });

  test("a host env key wins over a saved menu key", async ($, on) => {
    const w = world(on, { savedKey: "from-saved" });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(w.journal.requests[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(w.journal.requests[0]?.body.includes("from-saved")).toBe(false);
  });

  test("subagent, interrupted, errored, and empty-answer turns are not checkpoints", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await turnEnd($, w, { ...answered(), agentId: "agent-1" } as never);
    await turnEnd($, w, { ...answered(), reason: "aborted", isAborted: true } as never);
    await turnEnd($, w, { ...answered(), reason: "error" } as never);
    await turnEnd($, w, answered("   "));
    expect(w.journal.requests).toHaveLength(0);
    expect(stored(w)).toBeUndefined();
  });

  test("non-interactive sessions never judge", async ($, on) => {
    const w = world(on);
    await $.session.start({ cwd: "/work", surface: null, isInteractive: false });
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(0);
    expect(w.journal.statuses).toHaveLength(0);
  });

  test("a large static prompt alone is not useful history", async ($, on) => {
    const w = world(on);
    w.messages = longConversation().slice(2);
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.messageReads).toBe(1);
    expect(w.journal.requests).toHaveLength(0);
  });

  test("a turn that starts before the judgment runs invalidates it", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.turn.complete(answered());
    await $.turn.start({ turnId: "t2", origin: { kind: "composer" } } as never);
    await drain(w);
    expect(w.journal.requests).toHaveLength(0);
    expect(w.journal.statuses.includes(HINT)).toBe(false);
  });

  test("a turn that starts while TypeSafe answers discards the verdict", async ($, on) => {
    const w = world(on);
    let release: () => void = () => undefined;
    w.respond = () =>
      new Promise((resolve) => {
        release = () => resolve({ status: 200, text: JSON.stringify(jevAnswer()) });
      });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    await $.turn.start({ turnId: "t2", origin: { kind: "composer" } } as never);
    release();
    await drain(w);
    expect(w.journal.statuses.includes(HINT)).toBe(false);
  });

  test("no repeat at the same checkpoint; a new checkpoint can hint immediately", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    for (let i = 0; i < 3; i++) await turn($, w, `same-${i}`);
    expect(w.journal.requests).toHaveLength(1);
    w.messages = longConversation("Now add the README section.");
    await turn($, w, "new-1");
    expect(w.journal.requests).toHaveLength(2);
    expect(stored(w).lastHintAt).toBe(5);
    w.messages = longConversation("And a changelog entry.");
    await turn($, w, "new-2");
    expect(w.journal.requests).toHaveLength(3);
    expect(stored(w).lastHintAt).toBe(6);
  });

  test("the hint floor slides with context usage: a finished coordinating unit hints only once the window is fuller", async ($, on) => {
    // finished but coordinating scores 0.5: below the 0.80 floor at 30 % usage,
    // at the 0.50 floor from 90 % on. Same judgment, different window fill.
    const w = world(on);
    w.respond = async () => ({
      status: 200,
      text: JSON.stringify(jevAnswer({ completed: 1, handsOn: 0 })),
    });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(w.journal.statuses.includes(HINT)).toBe(false);
    w.usage.tokens = 180000;
    w.messages = longConversation("and now the window is nearly full");
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(2);
    expect(w.journal.statuses.includes(HINT)).toBe(true);
  });

  test("unknown context usage keeps the strictest floor", async ($, on) => {
    const w = world(on);
    w.respond = async () => ({
      status: 200,
      text: JSON.stringify(jevAnswer({ completed: 0.95, handsOn: 0.99 })),
    });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.statuses.includes(HINT)).toBe(true);
  });

  test("uncertain or insufficient verdicts leave context alone", async ($, on) => {
    const w = world(on);
    w.respond = async () => ({
      status: 200,
      text: JSON.stringify(jevAnswer({ completed: 0.68 })),
    });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(w.journal.statuses.includes(HINT)).toBe(false);
    expect(w.journal.compactions).toHaveLength(0);
  });

  for (const [name, respond, message] of [
    ["rate limit", async () => ({ status: 429, text: "" }), judgeErrorMessage("rate-limit")],
    ["malformed", async () => ({ status: 200, text: "{}" }), judgeErrorMessage("response")],
    [
      "authentication",
      async () => ({ status: 401, text: "" }),
      judgeErrorMessage("authentication"),
    ],
  ] as const) {
    test(`a ${name} failure backs off and reports once`, async ($, on) => {
      const w = world(on);
      w.respond = respond;
      await $.session.start(interactiveStart);
      await turnEnd($, w);
      expect(w.journal.toasts).toContain(message);
      expect(stored(w).retryAfter).toBe(START + 10000);
      w.messages = longConversation("next");
      await turnEnd($, w);
      expect(w.journal.requests).toHaveLength(1);
      await w.clock.advance(10000);
      w.messages = longConversation("later");
      await turnEnd($, w);
      expect(w.journal.requests).toHaveLength(2);
      expect(w.journal.toasts.filter((t) => t === message)).toHaveLength(1);
    });
  }

  test("a host refusal of nonessential traffic is named in the notice", async ($, on) => {
    const w = world(on);
    w.respond = async () => ({
      deny: "refused: nonessential network traffic is disabled for this session",
    });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.toasts).toContain(JUDGE_DISABLED_NETWORK_MESSAGE);
    expect(w.journal.statuses.includes(HINT)).toBe(false);
  });

  test("a two-second TypeSafe timeout leaves context alone", async ($, on) => {
    const w = world(on);
    w.respond = () => new Promise(() => undefined);
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    await w.clock.advance(2000);
    expect(w.journal.toasts).toContain(judgeErrorMessage("timeout"));
    expect(w.journal.statuses.includes(HINT)).toBe(false);
  });

  test("the endpoint override accepts only a loopback fixture", async ($, on) => {
    const w = world(on, { endpoint: "http://127.0.0.1:4567/v1/systemone" });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests[0]?.url).toBe("http://127.0.0.1:4567/v1/systemone");
  });

  test("a non-loopback endpoint override is ignored", async ($, on) => {
    const w = world(on, { endpoint: "https://collector.example/v1" });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
  });
});

describe("compaction cooldown", () => {
  test("any external compaction resets counters; judging waits for 20k fresh tokens and 3 exchanges", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.session.compact({ trigger: "manual", messages: MESSAGES });
    expect(stored(w).compacted).toBe(true);
    w.usage.tokens = 45000;
    for (let i = 0; i < 3; i++) {
      w.messages = longConversation(`ask ${i}`);
      await turn($, w, `a${i}`);
    }
    expect(w.journal.requests).toHaveLength(0);
    w.usage.tokens = 65000;
    await turn($, w, "a3");
    expect(w.journal.requests).toHaveLength(1);
  });

  test("a precompute or a subagent's compaction does not reset the session", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    await $.session.compact({ trigger: "precompute", messages: MESSAGES });
    await $.session.compact({ trigger: "auto", agentId: "sub", messages: MESSAGES });
    expect(stored(w).compacted).toBe(false);
  });
});

describe("automatic mode", () => {
  const acknowledged = { autoAcknowledged: true };
  const complete = () => longConversation().slice(2);

  function autoWorld(on: Parameters<typeof world>[0]) {
    const w = world(on, { mode: "auto", consent: acknowledged });
    // Fully covered state: no truncation or redaction, but real useful history.
    w.messages = [
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 ? ("assistant" as const) : ("user" as const),
        text: i % 2 ? `Step ${i} done. ${"detail ".repeat(1600)}` : `Next step ${i}.`,
        toolUses: [],
      })),
      ...Array.from({ length: RECENT_TAIL_MESSAGES }, (_, i) => ({
        role: i % 2 ? ("assistant" as const) : ("user" as const),
        text: i % 2 ? `Recent step ${i} done.` : `Continue ${i}.`,
        toolUses: [],
      })),
      { role: "user", text: "Run the tests.", toolUses: [] },
      { role: "assistant", text: "All 12 tests pass.", toolUses: [] },
      { role: "user", text: "Commit it.", toolUses: [] },
      { role: "assistant", text: "Committed as abc1234.", toolUses: [] },
      ...complete(),
    ];
    return w;
  }

  test("compacts once at a confident checkpoint and resets the cooldown", async ($, on) => {
    const w = autoWorld(on);
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.compactions).toEqual([
      {
        instructions:
          "The session reached a natural boundary; keep the current work, pending tasks, referenced files, and the next step exact.",
      },
    ]);
    expect(w.journal.statuses).toContain("compacting at a checkpoint (experimental auto)…");
    expect(w.journal.toasts).toContain("compaction completed: 60,000 to 3,300 tokens.");
    expect(w.journal.logs).toEqual(["automatic compaction completed: 60,000 to 3,300 tokens."]);
    expect(w.journal.statuses.at(-1)).toBeUndefined();
    expect(stored(w).compacted).toBe(true);
    expect(stored(w).completed).toBe(0);
    w.messages = longConversation("again");
    await turn($, w, "again");
    expect(w.journal.compactions).toHaveLength(1);
  });

  test("hint-level confidence also compacts in auto mode", async ($, on) => {
    const w = autoWorld(on);
    w.respond = async () => ({
      status: 200,
      text: JSON.stringify(jevAnswer({ completed: 0.95 })),
    });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.compactions).toHaveLength(1);
    expect(w.journal.statuses.includes(HINT)).toBe(false);
  });

  test("auto chosen in /config without the first-use confirmation never compacts", async ($, on) => {
    const w = autoWorld(on);
    w.store.set("preferences", { version: 1, autoAcknowledged: false });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.compactions).toHaveLength(0);
  });

  test("incomplete judge coverage still compacts when the judgment qualifies", async ($, on) => {
    const w = world(on, { mode: "auto", consent: acknowledged });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(w.journal.compactions).toHaveLength(1);
  });

  test("a vetoed or failed compaction backs off for a minute without resetting counters", async ($, on) => {
    const w = autoWorld(on);
    w.compact = async () => ({ skip: "another plugin vetoed" });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.compactions).toHaveLength(1);
    const state = stored(w);
    expect(state.retryAfter).toBe(START + 60000);
    expect(state.compacted).toBe(false);
    expect(w.journal.toasts).toContain(
      "Compaction failed or was cancelled. No immediate retry; Claude Code remains in control.",
    );
    w.compact = async () => Promise.reject(new Error("summarization produced empty response"));
    await w.clock.advance(60000);
    w.messages = [...w.messages, { role: "user", text: "more", toolUses: [] }];
    await turnEnd($, w);
    expect(w.journal.compactions).toHaveLength(2);
    expect(stored(w).retryAfter).toBe(START + 120000);
  });
});

describe("commands", () => {
  test("threshold saves a whole token count and reports it; invalid input keeps the setting", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("threshold 60000"));
    expect(w.rows.get(`${PLUGIN}.minContextTokens`)).toBe(60000);
    expect(w.journal.toasts.at(-1)).toBe("Minimum context saved: 60,000 tokens (all sessions).");
    for (const bad of ["40k", "0", "-5", "1.5", "4e4", "lots"]) {
      await $.command.run(commandRun(`threshold ${bad}`));
      expect(w.journal.toasts.at(-1)).toBe(
        "Enter a positive whole number of tokens, for example 40000.",
      );
    }
    expect(w.rows.get(`${PLUGIN}.minContextTokens`)).toBe(60000);
    await $.command.run(commandRun("threshold default"));
    expect(w.rows.get(`${PLUGIN}.minContextTokens`)).toBe(40000);
  });

  test("a minimum at or above the model window saves with a warning, never clamped", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("threshold 250000"));
    expect(w.rows.get(`${PLUGIN}.minContextTokens`)).toBe(250000);
    expect(w.journal.toasts.at(-1)).toContain(
      "at or above the active model's 200,000-token window",
    );
  });

  test("a save confirmation survives the hot reload a saved row causes", async ($, on) => {
    // Claude Code reloads the module after a saved row and drops the old environment's
    // toasts; the reloaded environment shows the confirmation at its session.start.
    const w = world(on, {
      store: { pendingNotice: { message: "Off saved (all sessions).", at: START - 1000 } },
    });
    await $.session.start(interactiveStart);
    expect(w.journal.toasts).toEqual(["Off saved (all sessions)."]);
    expect(w.store.has("pendingNotice")).toBe(false);
    await $.session.start(interactiveStart);
    expect(w.journal.toasts).toHaveLength(1);
  });

  test("a stale save confirmation is discarded", async ($, on) => {
    const w = world(on, {
      store: { pendingNotice: { message: "Off saved (all sessions).", at: START - 60000 } },
    });
    await $.session.start(interactiveStart);
    expect(w.journal.toasts).toHaveLength(0);
    expect(w.store.has("pendingNotice")).toBe(false);
  });

  test("a refused save is reported as not saved", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    w.denyConfig("a managed setting owns this row");
    await $.command.run(commandRun("off"));
    expect(w.rows.get(`${PLUGIN}.mode`)).toBe("hint");
    expect(w.journal.toasts.at(-1)).toBe("Not saved: a managed setting owns this row");
  });

  test("auto asks once; cancelling keeps the mode, confirming persists across sessions", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    w.answers.push(undefined);
    await $.command.run(commandRun("auto"));
    w.answers.push("Cancel");
    await $.command.run(commandRun("auto"));
    expect(w.rows.get(`${PLUGIN}.mode`)).toBe("hint");
    expect(w.journal.configSets).toHaveLength(0);
    w.answers.push("Enable automatic mode");
    await $.command.run(commandRun("auto"));
    expect(w.rows.get(`${PLUGIN}.mode`)).toBe("auto");
    expect(w.journal.asks).toHaveLength(3);
    expect(w.journal.asks[0]).toContain("Compaction is lossy");
    expect(w.journal.toasts.at(-1)).toBe(
      "Automatic mode saved (all sessions). A TypeSafe key is still required.",
    );
    await $.command.run(commandRun("hint"));
    await $.command.run(commandRun("auto"));
    expect(w.journal.asks).toHaveLength(3);
    expect(w.journal.compactions).toHaveLength(0);
    expect(w.journal.requests).toHaveLength(0);
  });

  test("hint and off save and say Claude Code's own compaction is unchanged", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("off"));
    expect(w.rows.get(`${PLUGIN}.mode`)).toBe("off");
    expect(w.journal.toasts.at(-1)).toBe(
      "Off saved (all sessions). Claude Code's built-in compaction is unchanged.",
    );
    await $.command.run(commandRun("hint"));
    expect(w.journal.toasts.at(-1)).toBe(
      "Hints only saved (all sessions). Claude Code's built-in compaction is unchanged.",
    );
  });

  test("sharing commands are gone; install is the sharing consent", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("sharing on"));
    expect(w.journal.toasts.at(-1)).toBe(
      "Use /compact-adviser, auto, hint, off, status, threshold <tokens|default>, snooze or dismiss.",
    );
    await $.command.run(commandRun("sharing off"));
    expect(w.journal.toasts.at(-1)).toBe(
      "Use /compact-adviser, auto, hint, off, status, threshold <tokens|default>, snooze or dismiss.",
    );
    expect(w.journal.asks).toHaveLength(0);
  });

  test("status reports readiness and the engine threshold, never the key", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("status"));
    const line = w.journal.logs.at(-1) ?? "";
    expect(line).toBe(
      "Mode: hint. Minimum: 40,000 tokens. Context: 60,000 (30% of the window; hint floor 0.80). Key: env. No cooldown; semantic checks still apply. Claude Code auto-compacts at 167,000 tokens. Request log: off. Settings: /config (compact-adviser rows) and /compact-adviser.",
    );
    expect(line.includes(KEY)).toBe(false);
  });

  test("status names this session's request log when logging is on", async ($, on) => {
    const w = world(on, { logRequests: true });
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("status"));
    const line = w.journal.logs.at(-1) ?? "";
    expect(line.includes("/home/fixture/.claude/compact-adviser-requests-session-1.jsonl")).toBe(
      true,
    );
    expect(line.includes(KEY)).toBe(false);
  });

  test("snooze suppresses advice for three exchanges; dismiss clears the hint", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("snooze"));
    expect(w.journal.toasts.at(-1)).toBe("Advice snoozed for three completed exchanges.");
    for (let i = 0; i < 3; i++) {
      w.messages = longConversation(`s${i}`);
      await turn($, w, `s${i}`);
    }
    expect(w.journal.requests).toHaveLength(0);
    w.messages = longConversation("s3");
    await turn($, w, "s3");
    expect(w.journal.requests).toHaveLength(1);
    expect(w.journal.statuses.at(-1)).toBe(HINT);
    await $.command.run(commandRun("dismiss"));
    expect(w.journal.statuses.at(-1)).toBeUndefined();
  });

  test("unknown arguments show the usage", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("threshold"));
    expect(w.journal.toasts.at(-1)).toBe(
      "Use /compact-adviser, auto, hint, off, status, threshold <tokens|default>, snooze or dismiss.",
    );
  });
});

describe("settings pane", () => {
  test("opens focused and draws the Pi menu rows with the saved values prefilled", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun(""));
    expect(w.journal.opened).toEqual([{ id: PLUGIN, focus: true }]);
    const tree = await $.ui.render(pane);
    const drawn = elements(tree);
    const select = drawn.find((e) => e.type === "Select" && e.props.label === "Mode");
    expect(select?.props.value).toBe("hint");
    expect(JSON.stringify(select?.props.options)).toBe(
      JSON.stringify([
        { value: "hint", label: "Hints only (default)" },
        { value: "auto", label: "Automatic (experimental)" },
        { value: "off", label: "Off" },
      ]),
    );
    const logging = drawn.find(
      (e) => e.type === "Select" && e.props.label === "Log TypeSafe requests",
    );
    expect(logging?.props.value).toBe("off");
    const input = drawn.find(
      (e) => e.type === "Input" && e.props.label === "Minimum context tokens",
    );
    expect(input?.props.value).toBe("40000");
    expect(input?.props.label).toBe("Minimum context tokens");
    const keyField = drawn.find((e) => e.type === "Input" && e.props.key === "typesafeApiKey");
    expect(keyField?.props.value).toBe("");
    expect(keyField?.props.submitLabel).toBe("set");
    const buttons = drawn.filter((e) => e.type === "Button").map((e) => e.props.label);
    expect(buttons).toEqual(["Reset minimum to 40,000", "Status", "Close"]);
    expect(text(tree)).toContain("TypeSafe API key: not saved");
    expect(text(tree)).toContain("A token count, not a percentage; no judgment below it.");
  });

  // The kit drives presses only; choosing a mode and submitting the minimum field are
  // exercised against the real Claude Code TUI by scripts/live-e2e.mjs.
  test("reset, status, and close act through the same paths as the commands", async ($, on) => {
    const w = world(on, { minimum: 75000, mode: "off" });
    await $.session.start(interactiveStart);
    await $.ui.render(pane);
    await $.ui.press({ plugin: PLUGIN, key: "reset" });
    await drain(w);
    expect(w.rows.get(`${PLUGIN}.minContextTokens`)).toBe(40000);
    expect(w.rows.get(`${PLUGIN}.mode`)).toBe("off");
    expect(w.journal.toasts.at(-1)).toBe("Minimum context saved: 40,000 tokens (all sessions).");
    await $.ui.render(pane);
    await $.ui.press({ plugin: PLUGIN, key: "status" });
    await drain(w);
    expect(text(await $.ui.render(pane))).toContain(
      "Mode: off. Minimum: 40,000 tokens. Context: 60,000 (30% of the window; hint floor 0.80). Key: env.",
    );
    expect(text(await $.ui.render(pane))).not.toContain("Sharing:");
    await $.ui.press({ plugin: PLUGIN, key: "close" });
    expect(w.journal.closed).toEqual([PLUGIN]);
  });

  test("the pane and status never print a saved TypeSafe key, and clear removes it", async ($, on) => {
    const secret = "tsk-menu-fixture-not-for-display";
    const w = world(on, { key: undefined, savedKey: secret });
    await $.session.start(interactiveStart);
    const tree = await $.ui.render(pane);
    expect(w.rows.get(`${PLUGIN}.typesafeApiKey`)).toBe(secret);
    expect(text(tree)).toContain("TypeSafe API key: saved");
    expect(text(tree)).not.toContain(secret);
    expect(
      elements(tree).find((e) => e.type === "Input" && e.props.key === "typesafeApiKey")?.props
        .value,
    ).toBe("");
    await $.command.run(commandRun("status"));
    expect(w.journal.logs.at(-1)).toContain("Key: saved");
    expect(w.journal.logs.at(-1)?.includes(secret)).toBe(false);
    await $.ui.press({ plugin: PLUGIN, key: "clearKey" });
    await drain(w);
    expect(w.rows.get(`${PLUGIN}.typesafeApiKey`)).toBe("");
    expect(w.journal.toasts.at(-1)).toBe(
      "Saved TypeSafe API key cleared (all sessions). Launch environment and .env still apply.",
    );
    expect(w.journal.toasts.every((line) => !line.includes(secret))).toBe(true);
    const cleared = await $.ui.render(pane);
    expect(text(cleared)).toContain("TypeSafe API key: not saved");
    expect(text(cleared)).not.toContain("Clear saved key");
    expect(text(cleared)).not.toContain(secret);
    await $.command.run(commandRun("status"));
    expect(w.journal.logs.at(-1)).toContain("Key: missing");
    expect(w.journal.logs.at(-1)?.includes(secret)).toBe(false);
  });

  test("another plugin's pane is left to it", async ($, on) => {
    world(on);
    on("ui.render", async () => ({ type: "Text", props: {}, children: ["OTHER"] }));
    await $.session.start(interactiveStart);
    expect(text(await $.ui.render({ ...(pane as object), requestId: "other" } as never))).toContain(
      "OTHER",
    );
  });
});
