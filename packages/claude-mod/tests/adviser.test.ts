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
import { SESSION_RETENTION_MS } from "../lib/state.ts";
import {
  answered,
  autoFocused,
  commandRun,
  elements,
  interactiveStart,
  jevAnswer,
  KEY,
  longConversation,
  PLUGIN,
  pane,
  rows,
  SESSION,
  START,
  text,
  type World,
  world,
} from "./support.ts";

const MESSAGES = [{ role: "user" as const, text: "hello", toolUses: [] }];
const HINT = "work appears completed or recorded. Run /compact to save tokens.";

function lastJsonl(write: { text: string } | undefined) {
  const lines = (write?.text ?? "").trim().split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1) ?? "");
}

function hinted(w: World) {
  return w.journal.statuses.some((s) => typeof s === "string" && s.includes(HINT));
}

/**
 * Drain `$.clock.after(0, …)` plus the async judgment it starts. The checkpoint
 * fingerprint is a `crypto.subtle` digest, which settles on a host task rather than a
 * microtask, so each round also waits out one digest of its own. A loaded machine can take
 * many rounds, so draining ends only once the visible world has stayed still for a while.
 */
async function drain(w: World) {
  const seen = () =>
    JSON.stringify([w.journal, [...w.store], [...w.rows]], (_key, value) =>
      typeof value === "function" ? undefined : value,
    );
  let last = seen();
  for (let quiet = 0, round = 0; quiet < 100 && round < 10000; round++) {
    await w.clock.settle();
    await crypto.subtle.digest("SHA-256", new Uint8Array());
    await Promise.resolve();
    const now = seen();
    quiet = now === last ? quiet + 1 : 0;
    last = now;
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

describe("the COMPACT_ADVISER_DISABLE kill switch", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
    test(`takes no product action when it is ${JSON.stringify(value)}`, async ($, on) => {
      // Automatic mode plus consent is the most enabled configuration there is; the
      // override still has to win over it.
      const w = world(on, {
        disable: value,
        mode: "auto",
        consent: { autoAcknowledged: true },
      });
      await $.session.start(interactiveStart);
      await turnEnd($, w);
      await $.session.compact({ trigger: "manual", messages: MESSAGES });
      expect(w.journal.commands).toHaveLength(0);
      expect(w.journal.statuses).toHaveLength(0);
      expect(w.journal.toasts).toHaveLength(0);
      expect(w.journal.requests).toHaveLength(0);
      expect(w.journal.compactions).toHaveLength(0);
      expect(w.journal.messageReads).toBe(0);
    });
  }

  for (const value of ["0", "false", "no", "off", "", " "]) {
    test(`stays enabled when it is ${JSON.stringify(value)}`, async ($, on) => {
      const w = world(on, { disable: value });
      await $.session.start(interactiveStart);
      expect(w.journal.commands).toEqual([PLUGIN]);
    });
  }
});

describe("turn-end gates", () => {
  test("the selected profile reaches the hook gate and response log", async ($, on) => {
    const w = world(on, { logRequests: true });
    w.rows.set(
      `${PLUGIN}.profile`,
      JSON.stringify({ version: 1, coordinationWeight: 1, floors: [[0, 1]] }),
    );
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(hinted(w)).toBe(false);
    const response = lastJsonl(w.journal.fsWrites[1]);
    expect(response.floor).toBe(1);
    expect(response.qualifies).toBe(false);
  });
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
    expect(w.journal.toasts.includes(HINT)).toBe(false);
    expect(w.journal.suggestions).toEqual([]);
    expect(w.journal.compactions).toHaveLength(0);
    expect(w.journal.fsWrites).toHaveLength(0);
  });

  test("a request log that exists but cannot be read is never overwritten", async ($, on) => {
    const w = world(on, { logRequests: true });
    w.logFiles.set(
      "/tmp/fixture-home/.claude/compact-adviser-requests-session-1.jsonl",
      "earlier line\n",
    );
    w.unreadableLogs.add("/tmp/fixture-home/.claude/compact-adviser-requests-session-1.jsonl");
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(hinted(w)).toBe(true);
    expect(w.journal.fsWrites).toHaveLength(0);
    expect(
      w.logFiles.get("/tmp/fixture-home/.claude/compact-adviser-requests-session-1.jsonl"),
    ).toBe("earlier line\n");
    await $.command.run(commandRun("status"));
    expect(w.journal.logs.at(-1)).toContain(
      "Request log: paused; the existing log could not be read, so it was left untouched.",
    );
  });

  test("a request log near the host's 4 MiB read limit rolls over to a numbered part", async ($, on) => {
    const w = world(on, { logRequests: true });
    w.logFiles.set(
      "/tmp/fixture-home/.claude/compact-adviser-requests-session-1.jsonl",
      "earlier line\n",
    );
    w.logSizes.set(
      "/tmp/fixture-home/.claude/compact-adviser-requests-session-1.jsonl",
      4 * 1024 * 1024 - 100,
    );
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(
      w.logFiles.get("/tmp/fixture-home/.claude/compact-adviser-requests-session-1.jsonl"),
    ).toBe("earlier line\n");
    const part =
      w.logFiles.get("/tmp/fixture-home/.claude/compact-adviser-requests-session-1.2.jsonl") ?? "";
    expect(part.trim().split("\n")).toHaveLength(2);
    await $.command.run(commandRun("status"));
    expect(w.journal.logs.at(-1)).toContain(
      "Request log: /tmp/fixture-home/.claude/compact-adviser-requests-session-1.2.jsonl.",
    );
  });

  test("a reloaded environment keeps appending to the latest log part", async ($, on) => {
    const w = world(on, { logRequests: true });
    w.logFiles.set(
      "/tmp/fixture-home/.claude/compact-adviser-requests-session-1.jsonl",
      "old line\n",
    );
    w.logSizes.set(
      "/tmp/fixture-home/.claude/compact-adviser-requests-session-1.jsonl",
      4 * 1024 * 1024 - 200000,
    );
    w.logFiles.set(
      "/tmp/fixture-home/.claude/compact-adviser-requests-session-1.2.jsonl",
      "newer line\n",
    );
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("status"));
    expect(w.journal.logs.at(-1)).toContain(
      "Request log: /tmp/fixture-home/.claude/compact-adviser-requests-session-1.2.jsonl.",
    );
    await turnEnd($, w);
    expect(
      w.logFiles.get("/tmp/fixture-home/.claude/compact-adviser-requests-session-1.jsonl"),
    ).toBe("old line\n");
    expect(
      (w.logFiles.get("/tmp/fixture-home/.claude/compact-adviser-requests-session-1.2.jsonl") ?? "")
        .trim()
        .split("\n"),
    ).toHaveLength(3);
  });

  test("turning logging on names the log part this session already rolled over to", async ($, on) => {
    const w = world(on);
    const base = "/tmp/fixture-home/.claude/compact-adviser-requests-session-1";
    w.logFiles.set(`${base}.jsonl`, "old line\n");
    w.logFiles.set(`${base}.2.jsonl`, "newer line\n");
    await $.session.start(interactiveStart);
    await $.command.run(commandRun(""));
    await $.ui.render(pane);
    await $.ui.press({ plugin: PLUGIN, key: "menu:logRequests" });
    await drain(w);
    await $.ui.render(pane);
    await $.ui.press({ plugin: PLUGIN, key: "logging:on" });
    await drain(w);
    expect(w.journal.logs.at(-1)).toBe(
      `TypeSafe request logging on (all sessions). This session logs to ${base}.2.jsonl.`,
    );
  });

  test("without HOME the request log is not written anywhere", async ($, on) => {
    const w = world(on, { logRequests: true, home: undefined });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(hinted(w)).toBe(true);
    expect(w.journal.fsWrites).toHaveLength(0);
    await $.command.run(commandRun("status"));
    expect(w.journal.logs.at(-1)).toContain("Request log: unavailable, HOME is not set.");
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
    expect(responseLine.usage).toBe(60000 / 167000);
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
            input: { file_path: "/tmp/fixture-home/.claude/settings.json" },
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
    expect(hinted(w)).toBe(false);
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

  test("non-interactive sessions stay inert", async ($, on) => {
    const stale = {
      version: 1,
      compacted: false,
      baseline: null,
      completed: 0,
      lastHintAt: null,
      lastHintKey: null,
      snoozeUntil: 0,
      retryAfter: 0,
      failures: 0,
      updatedAt: START - SESSION_RETENTION_MS - 1,
    };
    const w = world(on, {
      store: {
        "session:old": stale,
        pendingNotice: { message: "Off saved (all sessions).", at: START },
      },
    });
    await $.session.start({ cwd: "/work", surface: null, isInteractive: false });
    await turnEnd($, w);
    await $.session.compact({ trigger: "manual", messages: MESSAGES });
    expect(w.journal.commands).toHaveLength(0);
    expect(w.journal.requests).toHaveLength(0);
    expect(w.journal.statuses).toHaveLength(0);
    expect(w.journal.toasts).toHaveLength(0);
    expect(w.journal.usageReads).toBe(0);
    expect(w.store.has("session:old")).toBe(true);
    expect(w.store.has("pendingNotice")).toBe(true);
    expect(stored(w)).toBeUndefined();
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
    expect(hinted(w)).toBe(false);
  });

  test("a turn that starts while TypeSafe answers discards the verdict", async ($, on) => {
    const w = world(on);
    let markRequestStarted: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let release: () => void = () => undefined;
    w.respond = () => {
      markRequestStarted();
      return new Promise((resolve) => {
        release = () => resolve({ status: 200, text: JSON.stringify(jevAnswer()) });
      });
    };
    await $.session.start(interactiveStart);
    await $.turn.complete(answered());
    await w.clock.settle();
    await requestStarted;
    expect(w.journal.requests).toHaveLength(1);
    await $.turn.start({ turnId: "t2", origin: { kind: "composer" } } as never);
    release();
    await drain(w);
    expect(hinted(w)).toBe(false);
  });

  test("a turn that settles while an older judgment runs is judged once that one ends", async ($, on) => {
    const w = world(on);
    let calls = 0;
    w.respond = async () => {
      calls++;
      if (calls === 1) {
        // Turn 2 starts and settles while turn 1's judgment is in flight.
        await $.turn.start({ turnId: "two", origin: { kind: "composer" } } as never);
        w.messages = longConversation("second unit");
        await $.turn.complete(answered());
      }
      return { status: 200, text: JSON.stringify(jevAnswer()) };
    };
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(2);
    expect(hinted(w)).toBe(true);
  });

  test("the request log keeps the outcome of a judgment a newer turn made stale", async ($, on) => {
    const w = world(on, { logRequests: true });
    let calls = 0;
    w.respond = async () => {
      calls++;
      if (calls > 2) return { status: 200, text: JSON.stringify(jevAnswer()) };
      await $.turn.start({ turnId: `stale-${calls}`, origin: { kind: "composer" } } as never);
      w.messages = longConversation(`unit ${calls}`);
      await $.turn.complete(answered());
      return calls === 1
        ? { status: 200, text: JSON.stringify(jevAnswer()) }
        : { status: 500, text: "" };
    };
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(3);
    const lines = (
      w.logFiles.get("/tmp/fixture-home/.claude/compact-adviser-requests-session-1.jsonl") ?? ""
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.kind).sort()).toEqual([
      "error",
      "request",
      "request",
      "request",
      "response",
      "response",
    ]);
    expect(new Set(lines.map((line) => line.id)).size).toBe(3);
    // The stale failure is logged but is not this turn's backoff.
    expect(stored(w).failures).toBe(0);
  });

  test("status says a checkpoint is being judged, and why a late answer was discarded", async ($, on) => {
    const w = world(on);
    w.respond = async () => {
      await $.command.run(commandRun("status"));
      // Usage drops below the minimum while TypeSafe answers, with no new turn.
      w.usage.tokens = 10000;
      return { status: 200, text: JSON.stringify(jevAnswer()) };
    };
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.logs.at(-1)).toContain("Last turn end: being judged.");
    await $.command.run(commandRun("status"));
    expect(w.journal.logs.at(-1)).toContain(
      "Last turn end: judgment discarded, context below the minimum.",
    );
    expect(hinted(w)).toBe(false);
  });

  for (const interrupt of ["compact", "snooze"] as const) {
    test(`a ${interrupt} during a judgment leaves no turn end reading as being judged`, async ($, on) => {
      const w = world(on);
      w.respond = async () => {
        if (interrupt === "compact") {
          await $.session.compact({ trigger: "manual", messages: MESSAGES });
        } else {
          await $.command.run(commandRun("snooze"));
        }
        return { status: 200, text: JSON.stringify(jevAnswer()) };
      };
      await $.session.start(interactiveStart);
      await turnEnd($, w);
      await $.command.run(commandRun("status"));
      const status = w.journal.logs.at(-1) ?? "";
      expect(status).not.toContain("being judged");
      expect(status).toContain(
        interrupt === "compact"
          ? "Last turn end: judgment discarded, a compaction started."
          : "Last turn end: judgment discarded, settings or session changed meanwhile.",
      );
      // The cooldown sentence ends before the next one starts.
      expect(status).toMatch(/(after compaction|Snoozed)\. Last turn end:/);
      expect(hinted(w)).toBe(false);
      if (interrupt === "snooze")
        expect(stored(w).snoozeUntil).toBe((stored(w).completed as number) + 4);
    });
  }

  for (const [budget, hint, status] of [
    [0, false, "Budget: off. Context: 60,000 (36% of the context limit; hint floor 0.77)"],
    [65000, true, "Budget: 65,000 tokens. Context: 60,000 (92% of the budget; hint floor 0.50)"],
    // A budget above the 167k auto-compact point leaves that point in charge.
    [
      450000,
      false,
      "Budget: 450,000 tokens. Context: 60,000 (36% of the context limit; hint floor 0.77)",
    ],
  ] as const) {
    test(`a context budget of ${budget} decides how relaxed the floor is`, async ($, on) => {
      const w = world(on);
      w.rows.set(`${PLUGIN}.contextBudgetTokens`, budget);
      w.respond = async () => ({
        status: 200,
        text: JSON.stringify(jevAnswer({ completed: 0.8, handsOn: 0.5 })),
      });
      await $.session.start(interactiveStart);
      await turnEnd($, w);
      expect(w.journal.requests).toHaveLength(1);
      // Score 0.6: short of the floor at 60k of the 167k auto-compact point, past it at
      // 60k of a 65k budget.
      expect(hinted(w)).toBe(hint);
      await $.command.run(commandRun("status"));
      expect(w.journal.logs.at(-1)).toContain(status);
    });
  }

  test("a turn queued behind a judgment is gated again before its own request", async ($, on) => {
    const w = world(on);
    let calls = 0;
    w.respond = async () => {
      calls++;
      if (calls === 1) {
        // A turn end with no turn start: it queues behind this judgment, whose "not yet"
        // then starts the re-ask wait that the queued turn has not grown past.
        w.messages = longConversation("second unit");
        w.usage.tokens = 61000;
        await $.turn.complete(answered());
      }
      return { status: 200, text: JSON.stringify(jevAnswer({ completed: 0.1 })) };
    };
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    await $.command.run(commandRun("status"));
    expect(w.journal.logs.at(-1)).toContain(
      "Last turn end: not checked, cooldown: Waiting for 20k",
    );
  });

  test("a compaction that starts before a queued turn is asked leaves it not checked, not discarded", async ($, on) => {
    const w = world(on);
    let calls = 0;
    w.respond = async () => {
      calls++;
      if (calls === 1) {
        // A turn end with no turn start queues behind this judgment; a host compaction then
        // starts before it is asked, and is vetoed.
        w.messages = longConversation("second unit");
        await $.turn.complete(answered());
        w.hostCompact = async () => ({ skip: "another plugin vetoed" });
        await $.session.compact({ trigger: "manual", messages: MESSAGES });
      }
      return { status: 200, text: JSON.stringify(jevAnswer()) };
    };
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    await $.command.run(commandRun("status"));
    expect(w.journal.logs.at(-1)).toContain("Last turn end: not checked, a compaction started.");
  });

  test("a request log pauses after its last part instead of growing without end", async ($, on) => {
    const w = world(on, { logRequests: true });
    const base = "/tmp/fixture-home/.claude/compact-adviser-requests-session-1";
    for (let part = 1; part <= 100; part++) {
      const path = part === 1 ? `${base}.jsonl` : `${base}.${part}.jsonl`;
      w.logFiles.set(path, "full\n");
      w.logSizes.set(path, 4 * 1024 * 1024);
    }
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(w.logFiles.has(`${base}.101.jsonl`)).toBe(false);
    expect(w.logFiles.get(`${base}.100.jsonl`)).toBe("full\n");
    await $.command.run(commandRun("status"));
    expect(w.journal.logs.at(-1)).toContain("Request log: paused after 100 log parts.");
  });

  test("an answer discarded by a settings change still clears the TypeSafe backoff", async ($, on) => {
    const w = world(on);
    w.respond = async () => ({ status: 500, text: "" });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(stored(w).failures).toBe(1);
    await w.clock.advance(60000);
    w.respond = async () => {
      w.rows.set(`${PLUGIN}.minContextTokens`, 41000);
      return { status: 200, text: JSON.stringify(jevAnswer({ completed: 0.1 })) };
    };
    w.messages = longConversation("next");
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(2);
    expect([stored(w).failures, stored(w).judgedTokens]).toEqual([0, null]);
  });

  test("a compaction clears the re-ask wait a judgment started", async ($, on) => {
    const w = world(on);
    w.respond = async () => ({
      status: 200,
      text: JSON.stringify(jevAnswer({ completed: 0.1 })),
    });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(stored(w).judgedTokens).toBe(60000);
    await $.session.compact({ trigger: "manual", messages: MESSAGES });
    expect([stored(w).compacted, stored(w).judgedTokens]).toEqual([true, null]);
  });

  test("the first response after a compaction sets its baseline, not a long first turn's end", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.session.compact({ trigger: "manual", messages: MESSAGES });
    w.stepTokens = 60000;
    const step = $.turn.step({ turnId: "t", index: 0, model: "m", messageCount: 1 } as never);
    for await (const _ of step);
    // A later step of the same long turn does not move it.
    w.stepTokens = 90000;
    const later = $.turn.step({ turnId: "t", index: 1, model: "m", messageCount: 2 } as never);
    for await (const _ of later);
    expect(stored(w).baseline).toBe(60000);
    w.usage.tokens = 80000;
    for (const ask of ["a", "b", "c"]) {
      w.messages = longConversation(ask);
      await turnEnd($, w);
    }
    expect(w.journal.requests).toHaveLength(1);
  });

  test("after a judgment that did not advise, re-ask waits for 20k more tokens or 3 exchanges that change it by 5k", async ($, on) => {
    const w = world(on);
    w.respond = async () => ({
      status: 200,
      text: JSON.stringify(jevAnswer({ completed: 0.1 })),
    });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(stored(w).judgedTokens).toBe(60000);
    // Two more exchanges with under 20k of growth stay gated.
    w.usage.tokens = 79999;
    w.messages = longConversation("a");
    await turnEnd($, w);
    w.messages = longConversation("b");
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    // 20k of growth reopens it.
    w.usage.tokens = 80000;
    w.messages = longConversation("c");
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(2);
    // So does the third completed exchange, once the context has grown 5k.
    for (const ask of ["d", "e"]) {
      w.messages = longConversation(ask);
      await turnEnd($, w);
    }
    expect(w.journal.requests).toHaveLength(2);
    w.usage.tokens = 84999;
    w.messages = longConversation("f");
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(2);
    w.usage.tokens = 85000;
    w.messages = longConversation("g");
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(3);
  });

  test("a stored record from before the re-ask gate restores without a snooze", async ($, on) => {
    const w = world(on, {
      store: {
        [`session:${SESSION}`]: {
          version: 1,
          compacted: false,
          baseline: null,
          completed: 2,
          lastHintAt: null,
          lastHintKey: null,
          snoozeUntil: 0,
          retryAfter: 0,
          failures: 0,
          updatedAt: START,
        },
      },
    });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(stored(w).snoozeUntil).toBe(0);
  });

  test("a judgment discarded by a settings change mid-flight does not start the re-ask wait", async ($, on) => {
    const w = world(on);
    w.respond = async () => {
      w.rows.set(`${PLUGIN}.minContextTokens`, 41000);
      return { status: 200, text: JSON.stringify(jevAnswer({ completed: 0.1 })) };
    };
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(stored(w).judgedTokens).toBeNull();
    w.messages = longConversation("next");
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(2);
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
    expect(hinted(w)).toBe(false);
    w.usage.tokens = 180000;
    w.messages = longConversation("and now the window is nearly full");
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(2);
    expect(hinted(w)).toBe(true);
  });

  test("usage follows an enabled auto-compact threshold and otherwise uses the window", async ($, on) => {
    const w = world(on);
    w.usage = { tokens: 100000, window: 1000000, autoCompactThreshold: 200000 };
    w.respond = async () => ({
      status: 200,
      text: JSON.stringify(jevAnswer({ completed: 0.75, handsOn: 1 })),
    });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.statuses.filter((status) => status === HINT)).toHaveLength(1);

    w.usage = { tokens: 100000, window: 1000000 };
    w.messages = longConversation("the auto-compact threshold is absent");
    await turn($, w, "absent-threshold");
    expect(w.journal.statuses.filter((status) => status === HINT)).toHaveLength(1);

    w.usage = {
      tokens: 100000,
      window: 1000000,
      autoCompactThreshold: 200000,
      autoCompactEnabled: false,
    };
    w.messages = longConversation("auto-compact is disabled");
    await turn($, w, "disabled-auto-compact");
    expect(w.journal.statuses.filter((status) => status === HINT)).toHaveLength(1);
  });

  test("unknown context usage keeps the strictest floor", async ($, on) => {
    const w = world(on);
    w.respond = async () => ({
      status: 200,
      text: JSON.stringify(jevAnswer({ completed: 0.95, handsOn: 0.99 })),
    });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(hinted(w)).toBe(true);
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
    expect(hinted(w)).toBe(false);
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
      // Hosts cut a long toast short; the transcript keeps the whole explanation.
      expect(w.journal.logs).toContain(message);
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
    expect(w.journal.logs).toContain(JUDGE_DISABLED_NETWORK_MESSAGE);
    expect(hinted(w)).toBe(false);
  });

  test("a two-second TypeSafe timeout leaves context alone", async ($, on) => {
    const w = world(on);
    w.respond = () => new Promise(() => undefined);
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    await w.clock.advance(2000);
    expect(w.journal.toasts).toContain(judgeErrorMessage("timeout"));
    expect(hinted(w)).toBe(false);
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

  test("a turn end during a host compaction is not judged", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    w.hostCompact = async () => {
      await turnEnd($, w);
      return { messages: MESSAGES, tokensBefore: 50000, tokensAfter: 4000 };
    };
    await $.session.compact({ trigger: "manual", messages: MESSAGES });
    expect(w.journal.requests).toHaveLength(0);
  });

  test("a vetoed host compaction keeps the hint and the session's counters", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(hinted(w)).toBe(true);
    w.hostCompact = async () => ({ skip: "another plugin vetoed" });
    await $.session.compact({ trigger: "manual", messages: MESSAGES });
    expect(w.journal.statuses.at(-1)).toBe(HINT);
    expect(stored(w).compacted).toBe(false);
  });

  test("a subagent's response or one without usage leaves the baseline to the next main one", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.session.compact({ trigger: "manual", messages: MESSAGES });
    const steps = [
      { stepTokens: 50000, agentId: "sub" },
      { stepTokens: undefined, agentId: undefined },
      { stepTokens: 70000, agentId: undefined },
    ];
    for (const [index, step] of steps.entries()) {
      w.stepTokens = step.stepTokens;
      const run = $.turn.step({
        turnId: "t",
        index,
        model: "m",
        messageCount: index + 1,
        ...(step.agentId ? { agentId: step.agentId } : {}),
      } as never);
      for await (const _ of run);
    }
    expect(stored(w).baseline).toBe(70000);
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

  test("a checkpoint while automatic mode is unconfirmed starts the re-ask wait", async ($, on) => {
    const w = world(on, { mode: "auto" });
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(w.journal.compactions).toHaveLength(0);
    expect(stored(w).judgedTokens).toBe(60000);
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
    expect(hinted(w)).toBe(false);
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

  test("a compaction refused because a new turn started is dropped, not reported as a failure", async ($, on) => {
    const w = autoWorld(on);
    w.compact = async () => {
      await $.turn.start({ turnId: "next", origin: { kind: "composer" } } as never);
      throw new Error("a turn is running");
    };
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.compactions).toHaveLength(1);
    expect(stored(w).retryAfter).toBe(0);
    expect(w.journal.toasts.some((t) => t.startsWith("Compaction failed"))).toBe(false);
    expect(w.journal.statuses.at(-1)).toBeUndefined();
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
    // A compaction that did not happen did not act, so the re-ask gate holds this checkpoint.
    expect(state.judgedTokens).toBe(60000);
    expect(w.journal.toasts).toContain(
      "Compaction failed or was cancelled. No immediate retry; Claude Code remains in control.",
    );
    w.compact = async () => Promise.reject(new Error("summarization produced empty response"));
    await w.clock.advance(60000);
    w.messages = [...w.messages, { role: "user", text: "more", toolUses: [] }];
    await turnEnd($, w);
    expect(w.journal.compactions).toHaveLength(1);
    w.usage.tokens = 80000;
    w.messages = [...w.messages, { role: "user", text: "more still", toolUses: [] }];
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
    expect(w.journal.logs).toHaveLength(0);
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

  test("budget saves a whole token count or off; invalid input keeps the setting", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("budget 65000"));
    expect(w.rows.get(`${PLUGIN}.contextBudgetTokens`)).toBe(65000);
    expect(w.journal.toasts.at(-1)).toBe("Context budget saved: 65,000 tokens (all sessions).");
    await $.command.run(commandRun("budget 450k"));
    expect(w.journal.toasts.at(-1)).toBe(
      "Enter a whole number of tokens, for example 450000, or off.",
    );
    expect(w.rows.get(`${PLUGIN}.contextBudgetTokens`)).toBe(65000);
    await $.command.run(commandRun("budget off"));
    expect(w.rows.get(`${PLUGIN}.contextBudgetTokens`)).toBe(0);
    expect(w.journal.toasts.at(-1)).toBe("Context budget off (all sessions).");
  });

  test("a minimum at or above the model window saves with a warning, never clamped", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("threshold 250000"));
    expect(w.rows.get(`${PLUGIN}.minContextTokens`)).toBe(250000);
    // The toast keeps the headline a host can show whole; the warning goes to the transcript.
    expect(w.journal.toasts.at(-1)).toBe("Minimum context saved: 250,000 tokens (all sessions).");
    expect(w.journal.logs.at(-1)).toBe(
      "Minimum context saved: 250,000 tokens (all sessions). Warning: this is at or above the active model's 200,000-token window, so advice will not trigger before Claude Code's own compaction.",
    );
  });

  test("a save confirmation survives the hot reload a saved row causes", async ($, on) => {
    // Claude Code reloads the module after a saved row and drops the old environment's
    // toasts; the reloaded environment shows the confirmation at its session.start.
    const w = world(on, {
      store: {
        pendingNotice: { message: "Off saved (all sessions).", detail: "More.", at: START - 1000 },
      },
    });
    await $.session.start(interactiveStart);
    expect(w.journal.toasts).toEqual(["Off saved (all sessions)."]);
    expect(w.journal.logs).toEqual(["Off saved (all sessions). More."]);
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
    expect(w.journal.logs.at(-1)).toBe("Not saved: a managed setting owns this row");
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
    expect(w.journal.toasts.at(-1)).toBe("Automatic mode saved (all sessions).");
    expect(w.journal.logs.at(-1)).toBe(
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
    expect(w.journal.toasts.at(-1)).toBe("Off saved (all sessions).");
    expect(w.journal.logs.at(-1)).toBe(
      "Off saved (all sessions). Claude Code's built-in compaction is unchanged.",
    );
    await $.command.run(commandRun("hint"));
    expect(w.journal.toasts.at(-1)).toBe("Hints only saved (all sessions).");
    expect(w.journal.logs.at(-1)).toBe(
      "Hints only saved (all sessions). Claude Code's built-in compaction is unchanged.",
    );
  });

  test("sharing commands are gone; install is the sharing consent", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("sharing on"));
    expect(w.journal.toasts.at(-1)).toBe(
      "Use /compact-adviser, auto, hint, off, status, threshold <tokens|default>, budget <tokens|off>, snooze or dismiss.",
    );
    await $.command.run(commandRun("sharing off"));
    expect(w.journal.toasts.at(-1)).toBe(
      "Use /compact-adviser, auto, hint, off, status, threshold <tokens|default>, budget <tokens|off>, snooze or dismiss.",
    );
    expect(w.journal.asks).toHaveLength(0);
  });

  test("status reports readiness and the engine threshold, never the key", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("status"));
    const line = w.journal.logs.at(-1) ?? "";
    expect(line).toBe(
      "Mode: hint. Minimum: 40,000 tokens. Budget: off. Context: 60,000 (36% of the context limit; hint floor 0.77). Key: env. No cooldown; semantic checks still apply. Claude Code auto-compacts at 167,000 tokens. Request log: off. Settings: /config (compact-adviser rows) and /compact-adviser.",
    );
    expect(line.includes(KEY)).toBe(false);
  });

  test("status names this session's request log when logging is on", async ($, on) => {
    const w = world(on, { logRequests: true });
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("status"));
    const line = w.journal.logs.at(-1) ?? "";
    expect(
      line.includes("/tmp/fixture-home/.claude/compact-adviser-requests-session-1.jsonl"),
    ).toBe(true);
    expect(line.includes(KEY)).toBe(false);
  });

  test("status says why the last turn end did or did not advise", async ($, on) => {
    const w = world(on, { minimum: 100000 });
    const last = () => (w.journal.logs.at(-1) ?? "").match(/Last turn end: [^.]*\./)?.[0];
    await $.session.start(interactiveStart);
    await $.command.run(commandRun("status"));
    expect(last()).toBeUndefined();
    await turnEnd($, w);
    await $.command.run(commandRun("status"));
    expect(last()).toBe("Last turn end: not checked, context below the minimum.");
    await turnEnd($, w, { ...answered(), isAborted: true });
    await $.command.run(commandRun("status"));
    expect(last()).toBe("Last turn end: not checked, the turn was interrupted.");
    w.usage.tokens = 150000;
    w.respond = async () => ({
      status: 200,
      text: JSON.stringify(jevAnswer({ completed: 0.1 })),
    });
    await turnEnd($, w);
    await $.command.run(commandRun("status"));
    expect(last()).toBe("Last turn end: judged, not a checkpoint yet.");
    await turnEnd($, w);
    await $.command.run(commandRun("status"));
    expect(last()).toBe(
      "Last turn end: not checked, cooldown: Waiting for 20k new tokens, or 3 completed exchanges that change the context by 5k, since the last judgment.",
    );
    w.usage.tokens = 170000;
    w.respond = async () => ({ status: 200, text: JSON.stringify(jevAnswer()) });
    w.messages = longConversation("next unit");
    await turnEnd($, w);
    await $.command.run(commandRun("status"));
    expect(last()).toBe("Last turn end: judged a checkpoint; hint shown.");
    w.respond = async () => ({ status: 500, text: "" });
    w.messages = longConversation("another unit");
    await turnEnd($, w);
    await $.command.run(commandRun("status"));
    expect(last()).toBe("Last turn end: the judgment failed; context left unchanged.");
    await turnEnd($, w);
    await $.command.run(commandRun("status"));
    expect(last()).toBe("Last turn end: not checked, cooldown: TypeSafe backoff.");
  });

  test("a late judgment from an earlier turn never overwrites the latest turn's reason", async ($, on) => {
    const w = world(on);
    w.respond = async () => {
      // Turn 2 starts and settles below the minimum while turn 1's judgment is in flight.
      await $.turn.start({ turnId: "two", origin: { kind: "composer" } } as never);
      w.usage.tokens = 10000;
      await $.turn.complete(answered());
      return { status: 200, text: JSON.stringify(jevAnswer()) };
    };
    await $.session.start(interactiveStart);
    await turnEnd($, w);
    expect(w.journal.requests).toHaveLength(1);
    expect(hinted(w)).toBe(false);
    await $.command.run(commandRun("status"));
    expect(w.journal.logs.at(-1)).toContain(
      "Last turn end: not checked, context below the minimum.",
    );
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
      "Use /compact-adviser, auto, hint, off, status, threshold <tokens|default>, budget <tokens|off>, snooze or dismiss.",
    );
  });
});

describe("settings pane", () => {
  test("opens focused and lists the Pi menu rows, arrow-keyed, with the values in effect", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun(""));
    expect(w.journal.opened).toEqual([{ id: PLUGIN, focus: true }]);
    const tree = await $.ui.render(pane);
    expect(rows(tree)).toEqual([
      "Mode Hints only (default)",
      "Minimum context 40,000 tokens",
      "Log TypeSafe requests Off",
      "TypeSafe API key from the environment",
      "Reset minimum to 40,000",
      "Status",
      "Close",
    ]);
    // Plain buttons only: the arrows move between rows, no picker or field takes them.
    const drawn = elements(tree);
    expect(drawn.some((e) => e.type === "Select" || e.type === "Input")).toBe(false);
    expect(drawn.filter((e) => e.type === "Button").every((e) => e.props.plain === true)).toBe(
      true,
    );
    expect(autoFocused(tree)).toBe("menu:mode");
    expect(text(tree)).toContain("Compact adviser");
    expect(text(tree)).toContain("saved for all sessions");
    expect(text(tree)).toContain("↑↓ move · Enter select · Esc close");
    expect(text(tree)).not.toContain(KEY);
  });

  // Escape inside a view (the engine's own close, origin person, which the mod refuses and
  // turns into Back) and where the focus ring lands are outside the kit's reach: the kit
  // drives presses only, and its `ui.focus` chain skips a test's hooks. The `autoFocus`
  // element is asserted here; scripts/live-e2e.mjs presses the real keys.
  test("a row opens its own view; an option or Back returns to the list", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun(""));
    await $.ui.render(pane);
    await $.ui.press({ plugin: PLUGIN, key: "menu:logRequests" });
    await drain(w);
    let tree = await $.ui.render(pane);
    expect(text(tree)).toContain("› Log TypeSafe requests");
    expect(rows(tree)).toEqual(["● Off (default)", "On", "Back"]);
    expect(autoFocused(tree)).toBe("logging:off");
    await $.ui.press({ plugin: PLUGIN, key: "logging:on" });
    await drain(w);
    expect(w.rows.get(`${PLUGIN}.logRequests`)).toBe(true);
    expect(w.journal.toasts.at(-1)).toBe("TypeSafe request logging on (all sessions).");
    expect(w.journal.logs.at(-1)).toMatch(
      /^TypeSafe request logging on \(all sessions\)\. This session logs to .*compact-adviser-requests-.*\.jsonl\.$/,
    );
    tree = await $.ui.render(pane);
    expect(rows(tree)[2]).toBe("Log TypeSafe requests On");
    // The ring goes back to the row that was opened, so the arrows continue from there.
    expect(autoFocused(tree)).toBe("menu:logRequests");

    await $.ui.press({ plugin: PLUGIN, key: "menu:mode" });
    tree = await $.ui.render(pane);
    expect(rows(tree)).toEqual([
      "● Hints only (default)",
      "Automatic (experimental)",
      "Off",
      "Back",
    ]);
    // Picking the current option changes nothing and returns.
    await $.ui.press({ plugin: PLUGIN, key: "mode:hint" });
    await drain(w);
    expect(w.journal.configSets).toEqual([{ key: `${PLUGIN}.logRequests`, value: true }]);
    expect(rows(await $.ui.render(pane))[0]).toBe("Mode Hints only (default)");
    await $.ui.press({ plugin: PLUGIN, key: "menu:mode" });
    await $.ui.render(pane);
    await $.ui.press({ plugin: PLUGIN, key: "back" });
    expect(rows(await $.ui.render(pane))).toHaveLength(7);

    await $.ui.press({ plugin: PLUGIN, key: "menu:minimum" });
    tree = await $.ui.render(pane);
    expect(text(tree)).toContain("› Minimum context");
    const field = elements(tree).find((e) => e.type === "Input");
    expect(field?.props.key).toBe("minimum");
    expect(field?.props.value).toBe("40000");
    expect(field?.props.submitLabel).toBe("save");
    expect(field?.props.autoFocus).toBe(true);
    expect(text(tree)).toContain("A token count, not a percentage; no judgment below it.");
    expect(rows(tree)).toEqual(["Back"]);
    await $.ui.press({ plugin: PLUGIN, key: "back" });
    await drain(w);
    tree = await $.ui.render(pane);
    expect(rows(tree)).toHaveLength(7);
    expect(autoFocused(tree)).toBe("menu:minimum");
    expect(w.journal.closed).toEqual([]);
  });

  test("choosing Automatic asks first; either answer returns to the list", async ($, on) => {
    const w = world(on);
    await $.session.start(interactiveStart);
    await $.command.run(commandRun(""));
    await $.ui.render(pane);
    await $.ui.press({ plugin: PLUGIN, key: "menu:mode" });
    await $.ui.render(pane);
    w.answers = [undefined];
    await $.ui.press({ plugin: PLUGIN, key: "mode:auto" });
    await drain(w);
    expect(w.journal.asks).toHaveLength(1);
    expect(w.rows.get(`${PLUGIN}.mode`)).toBe("hint");
    // The dialog took the keyboard; the pane asked for it back.
    expect(w.journal.opened).toHaveLength(2);
    expect(rows(await $.ui.render(pane))[0]).toBe("Mode Hints only (default)");
    await $.ui.press({ plugin: PLUGIN, key: "menu:mode" });
    await $.ui.render(pane);
    w.answers = ["Enable automatic mode"];
    await $.ui.press({ plugin: PLUGIN, key: "mode:auto" });
    await drain(w);
    expect(w.rows.get(`${PLUGIN}.mode`)).toBe("auto");
    expect(w.journal.toasts.at(-1)).toBe("Automatic mode saved (all sessions).");
    expect(w.journal.logs.at(-1)).toBe(
      "Automatic mode saved (all sessions). A TypeSafe key is still required.",
    );
    expect(rows(await $.ui.render(pane))[0]).toBe("Mode Automatic (experimental)");
  });

  test("reset, status, and close act through the same paths as the commands", async ($, on) => {
    const w = world(on, { minimum: 75000, mode: "off" });
    await $.session.start(interactiveStart);
    await $.ui.render(pane);
    await $.ui.press({ plugin: PLUGIN, key: "menu:reset" });
    await drain(w);
    expect(w.rows.get(`${PLUGIN}.minContextTokens`)).toBe(40000);
    expect(w.rows.get(`${PLUGIN}.mode`)).toBe("off");
    expect(w.journal.toasts.at(-1)).toBe("Minimum context saved: 40,000 tokens (all sessions).");
    await $.ui.render(pane);
    await $.ui.press({ plugin: PLUGIN, key: "menu:status" });
    await drain(w);
    expect(text(await $.ui.render(pane))).toContain(
      "Mode: off. Minimum: 40,000 tokens. Budget: off. Context: 60,000 (36% of the context limit; hint floor 0.77). Key: env.",
    );
    expect(text(await $.ui.render(pane))).not.toContain("Sharing:");
    await $.ui.press({ plugin: PLUGIN, key: "menu:close" });
    expect(w.journal.closed).toEqual([PLUGIN]);
  });

  test("the key row names the key in effect and its source, never the value", async ($, on) => {
    const secret = "tsk-menu-fixture-not-for-display";
    const w = world(on, {
      key: undefined,
      savedKey: secret,
      dotenv: "TYPESAFE_API_KEY=tsk-dotenv-fixture-not-for-display\n",
    });
    await $.session.start(interactiveStart);
    let tree = await $.ui.render(pane);
    expect(rows(tree)[3]).toBe("TypeSafe API key saved");
    expect(text(tree)).not.toContain(secret);
    await $.ui.press({ plugin: PLUGIN, key: "menu:typesafeApiKey" });
    tree = await $.ui.render(pane);
    expect(text(tree)).toContain("› TypeSafe API key");
    expect(text(tree)).toContain("In effect: the key saved here, for all sessions.");
    const field = elements(tree).find((e) => e.type === "Input");
    expect(field?.props.key).toBe("typesafeApiKey");
    expect(field?.props.value).toBe("");
    expect(field?.props.placeholder).toBe("paste a key to replace the saved one");
    expect(field?.props.autoFocus).toBe(true);
    expect(rows(tree)).toEqual(["Clear saved key", "Back"]);
    expect(text(tree)).not.toContain(secret);
    await $.command.run(commandRun("status"));
    expect(w.journal.logs.at(-1)).toContain("Key: saved");
    expect(w.journal.logs.at(-1)?.includes(secret)).toBe(false);
    await $.ui.press({ plugin: PLUGIN, key: "clearKey" });
    await drain(w);
    expect(w.rows.get(`${PLUGIN}.typesafeApiKey`)).toBe("");
    expect(w.journal.toasts.at(-1)).toBe("Saved TypeSafe API key cleared (all sessions).");
    expect(w.journal.logs.at(-1)).toBe(
      "Saved TypeSafe API key cleared (all sessions). Launch environment and .env still apply.",
    );
    expect(w.journal.toasts.every((line) => !line.includes(secret))).toBe(true);
    // Clearing removes only the saved key: the .env one now applies, and the list says so.
    tree = await $.ui.render(pane);
    expect(rows(tree)[3]).toBe("TypeSafe API key from .env");
    expect(text(tree)).not.toContain(secret);
    expect(text(tree)).not.toContain("tsk-dotenv");
    await $.ui.press({ plugin: PLUGIN, key: "menu:typesafeApiKey" });
    tree = await $.ui.render(pane);
    expect(text(tree)).toContain(
      "In effect: TYPESAFE_API_KEY from the .env file in the working directory.",
    );
    expect(elements(tree).find((e) => e.type === "Input")?.props.placeholder).toBe(
      "paste a key to save it",
    );
    expect(rows(tree)).toEqual(["Back"]);
    await $.command.run(commandRun("status"));
    expect(w.journal.logs.at(-1)).toContain("Key: .env");
  });

  test("an environment key wins over a saved one, and the pane says so", async ($, on) => {
    const secret = "tsk-menu-fixture-not-for-display";
    const w = world(on, { savedKey: secret });
    await $.session.start(interactiveStart);
    let tree = await $.ui.render(pane);
    expect(rows(tree)[3]).toBe("TypeSafe API key from the environment");
    await $.ui.press({ plugin: PLUGIN, key: "menu:typesafeApiKey" });
    tree = await $.ui.render(pane);
    expect(text(tree)).toContain(
      "In effect: TYPESAFE_API_KEY from the launch environment, which wins over the key saved here.",
    );
    expect(rows(tree)).toEqual(["Clear saved key", "Back"]);
    expect(text(tree)).not.toContain(secret);
    expect(text(tree)).not.toContain(KEY);
    await $.ui.press({ plugin: PLUGIN, key: "clearKey" });
    await drain(w);
    expect(w.rows.get(`${PLUGIN}.typesafeApiKey`)).toBe("");
    expect(rows(await $.ui.render(pane))[3]).toBe("TypeSafe API key from the environment");
  });

  test("a denied clear keeps the key view and the saved key", async ($, on) => {
    const secret = "tsk-menu-fixture-not-for-display";
    const w = world(on, { key: undefined, savedKey: secret });
    await $.session.start(interactiveStart);
    await $.ui.render(pane);
    await $.ui.press({ plugin: PLUGIN, key: "menu:typesafeApiKey" });
    await $.ui.render(pane);
    w.denyConfig("a managed setting owns this row");
    await $.ui.press({ plugin: PLUGIN, key: "clearKey" });
    await drain(w);
    expect(w.rows.get(`${PLUGIN}.typesafeApiKey`)).toBe(secret);
    expect(w.journal.toasts.at(-1)).toBe("Not saved: a managed setting owns this row");
    const tree = await $.ui.render(pane);
    expect(rows(tree)).toEqual(["Clear saved key", "Back"]);
    expect(elements(tree).find((e) => e.type === "Input")?.props.key).toBe("typesafeApiKey");
  });

  test("without any key the list says so and the view explains where one can come from", async ($, on) => {
    world(on, { key: undefined });
    await $.session.start(interactiveStart);
    expect(rows(await $.ui.render(pane))[3]).toBe("TypeSafe API key missing");
    await $.ui.press({ plugin: PLUGIN, key: "menu:typesafeApiKey" });
    const tree = await $.ui.render(pane);
    expect(text(tree)).toContain(
      "No key in effect. Save one here, or set TYPESAFE_API_KEY in the environment or a .env file.",
    );
    expect(rows(tree)).toEqual(["Back"]);
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
