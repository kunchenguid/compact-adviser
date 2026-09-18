/**
 * The Pi extension, the Claude mod, and the Codex plugin must ask TypeSafe the
 * same question.
 *
 * Judge wording is tuned against the judgment-eval corpus, and a tuning pass
 * that lands in one package but not the others would silently ship different
 * products. These assertions compare what each package actually sends and
 * decides, not how any of the files is written.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as claudeDisable from "../../claude-mod/lib/disable.ts";
import * as claude from "../../claude-mod/lib/judge.ts";
import * as claudeLog from "../../claude-mod/lib/log.ts";
import * as claudeSnapshot from "../../claude-mod/lib/snapshot.ts";
import * as claudeState from "../../claude-mod/lib/state.ts";
import * as codex from "../../codex-plugin/src/judge.ts";
import * as codexLog from "../../codex-plugin/src/log.ts";
import * as codexSnapshot from "../../codex-plugin/src/snapshot.ts";
import * as codexState from "../../codex-plugin/src/state.ts";
import * as piContext from "../src/context.ts";
import * as piDisable from "../src/disable.ts";
import * as pi from "../src/judge.ts";
import * as piLog from "../src/log.ts";
import * as piState from "../src/state.ts";

/** Shaped like a real `snapshot()`, small enough to stay well under the cap. */
const state = {
  userConstraints: [{ role: "user", text: "Ship the fix, then report." }],
  recent: [
    { role: "assistant", text: "", tools: [{ tool: "Bash", error: false, excerpt: "ok" }] },
    { role: "assistant", text: "Escalated as review-4 and holding for your call." },
  ],
  previousSummary: null,
  savedArtifacts: ["report.md"],
  coverage: { userConstraints: true, recent: true },
  compaction: { native: 0 },
};

test("every package sends byte-identical request bodies", () => {
  for (const s of [state, { ...state, recent: [] }, {}, null]) {
    assert.equal(claude.requestBody(s), pi.requestBody(s));
    assert.equal(codex.requestBody(s), pi.requestBody(s));
  }
});

test("the question set and the floor schedule match", () => {
  for (const other of [claude, codex]) {
    assert.deepEqual(other.QUESTIONS, pi.QUESTIONS);
    assert.equal(other.FLOOR_MAX, pi.FLOOR_MAX);
    assert.equal(other.FLOOR_MIN, pi.FLOOR_MIN);
    assert.equal(other.USAGE_STRICT_UNTIL, pi.USAGE_STRICT_UNTIL);
    assert.equal(other.USAGE_LOOSE_AT, pi.USAGE_LOOSE_AT);
    for (let u = -0.1; u <= 1.1; u += 0.01) assert.equal(other.floorFor(u), pi.floorFor(u));
    assert.equal(other.floorFor(Number.NaN), pi.floorFor(Number.NaN));
    assert.equal(other.ENDPOINT, pi.ENDPOINT);
    assert.equal(other.MAX_REQUEST_BYTES, pi.MAX_REQUEST_BYTES);
  }
  assert.deepEqual(Object.keys(pi.QUESTIONS), ["done", "shape"]);
  assert.equal(pi.USAGE_STRICT_UNTIL, 0.1);
  assert.equal(pi.USAGE_LOOSE_AT, 0.9);
  assert.equal(pi.FLOOR_MIN, 0.5);
});

test("every package scores and gates the same judgments the same way", () => {
  const grid = [0, 0.3, 0.5, 0.79, 0.8, 0.9, 0.95, 1];
  for (const finished of grid) {
    for (const handsOn of grid) {
      const judgment = {
        done: {
          choice: finished >= 0.5 ? "finished" : "not_finished",
          probabilities: { finished, not_finished: 1 - finished, unclear: 0 },
          confidence: 1,
        },
        shape: {
          choice: handsOn >= 0.5 ? "hands_on" : "coordinating",
          probabilities: { hands_on: handsOn, coordinating: 1 - handsOn, unclear: 0 },
          confidence: 1,
        },
        model: "jev-test",
        inputTokens: 1,
        outputTokens: 1,
      };
      for (const [name, other] of [
        ["claude", claude],
        ["codex", codex],
      ] as const) {
        assert.equal(other.score(judgment), pi.score(judgment));
        for (const usage of [Number.NaN, 0, 0.3, 0.5, 0.7, 0.85, 1]) {
          assert.equal(
            other.qualifies(judgment, usage),
            pi.qualifies(judgment, usage),
            `${name} disagreed at finished=${finished} handsOn=${handsOn} usage=${usage}`,
          );
        }
      }
    }
  }
});

test("every package parses the same wire response into the same judgment", () => {
  const response = {
    model: "jev-1.13.0",
    answers: {
      done: {
        type: "choice",
        choice: "finished",
        probabilities: { finished: 0.93, not_finished: 0.06, unclear: 0.01 },
        confidence: 0.88,
      },
      shape: {
        type: "choice",
        choice: "hands_on",
        probabilities: { hands_on: 0.97, coordinating: 0.02, unclear: 0.01 },
        confidence: 0.95,
      },
    },
    usage: { input_tokens: 7440, output_tokens: 44 },
  };
  assert.deepEqual(claude.parseJudgment(response), pi.parseJudgment(response));
  assert.deepEqual(codex.parseJudgment(response), pi.parseJudgment(response));
  assert.equal(claude.qualifies(pi.parseJudgment(response), 0.2), true);
  for (const other of [claude, codex]) {
    assert.equal(
      other.qualifies(pi.parseJudgment(response), 0.2),
      pi.qualifies(pi.parseJudgment(response), 0.2),
    );
  }
});

test("every package scrubs owned settings fields and known key values the same way", () => {
  const secret = "tsk-saved-key-must-not-leave";
  const dump = JSON.stringify({
    mode: "hint",
    typesafeApiKey: secret,
    "compact-adviser.typesafeApiKey": secret,
  });
  for (const other of [claudeSnapshot, codexSnapshot]) {
    assert.deepEqual(other.redact(dump), piContext.redact(dump));
    assert.deepEqual(other.redactOwnedSettings(dump), piContext.redactOwnedSettings(dump));
    assert.deepEqual(
      other.scrubKnownSecrets(`keep ${secret} nearby`, [secret]),
      piContext.scrubKnownSecrets(`keep ${secret} nearby`, [secret]),
    );
  }
  assert.ok(!claudeSnapshot.redact(dump).text.includes(secret));
  assert.ok(claudeSnapshot.redact(dump).text.includes("hint"));
});

test("every package writes the same TypeSafe log line shape", () => {
  const body = pi.requestBody(state);
  const judgment = pi.parseJudgment({
    model: "jev-1.13.0",
    answers: {
      done: {
        type: "choice",
        choice: "finished",
        probabilities: { finished: 0.93, not_finished: 0.06, unclear: 0.01 },
        confidence: 0.88,
      },
      shape: {
        type: "choice",
        choice: "hands_on",
        probabilities: { hands_on: 0.97, coordinating: 0.02, unclear: 0.01 },
        confidence: 0.95,
      },
    },
    usage: { input_tokens: 7440, output_tokens: 44 },
  });
  const at = "2026-09-18T00:00:00.000Z";
  for (const [other, judge] of [
    [claudeLog, claude],
    [codexLog, codex],
  ] as const) {
    assert.equal(other.requestLogId(body), piLog.requestLogId(body));
    assert.equal(other.requestLogLine(body, at), piLog.requestLogLine(body, at));
    assert.equal(
      other.responseLogLine(body, judgment, 0.2, at),
      piLog.responseLogLine(body, judgment, 0.2, at),
    );
    assert.equal(
      other.responseLogLine(body, judgment, Number.NaN, at),
      piLog.responseLogLine(body, judgment, Number.NaN, at),
    );
    assert.equal(other.errorLogLine("timeout", body, at), piLog.errorLogLine("timeout", body, at));
    assert.equal(
      other.errorLogLine("input", undefined, at),
      piLog.errorLogLine("input", undefined, at),
    );
    assert.equal(
      other.loggedJudgeErrorKind(new judge.JudgeError("network")),
      piLog.loggedJudgeErrorKind(new pi.JudgeError("network")),
    );
    assert.equal(
      other.loggedJudgeErrorKind(new Error("boom")),
      piLog.loggedJudgeErrorKind(new Error("boom")),
    );
  }
});

test("every package applies the same cooldownReason gates", () => {
  const waiting = "Waiting for 20k new tokens and 3 completed exchanges after compaction";
  const cases: Array<{
    name: string;
    tokens: number;
    now: number;
    compacted: boolean;
    patch: {
      completed?: number;
      snoozeUntil?: number;
      retryAfter?: number;
      lastHintAt?: number | null;
      baseline?: number | null;
    };
    reason: string | undefined;
  }> = [
    { name: "fresh", tokens: 50000, now: 0, compacted: false, patch: {}, reason: undefined },
    {
      name: "recent hint is not a cooldown",
      tokens: 60000,
      now: 0,
      compacted: false,
      patch: { completed: 4, lastHintAt: 2 },
      reason: undefined,
    },
    {
      name: "snooze",
      tokens: 90000,
      now: 5,
      compacted: false,
      patch: { snoozeUntil: 3, completed: 0 },
      reason: "Snoozed",
    },
    {
      name: "typesafe backoff",
      tokens: 60000,
      now: 10999,
      compacted: false,
      patch: { retryAfter: 11000 },
      reason: "TypeSafe backoff",
    },
    {
      name: "post-compaction no baseline",
      tokens: 90000,
      now: 1,
      compacted: true,
      patch: { completed: 1, baseline: null },
      reason: waiting,
    },
    {
      name: "post-compaction short of tokens",
      tokens: 24999,
      now: 3,
      compacted: true,
      patch: { completed: 3, baseline: 5000 },
      reason: waiting,
    },
    {
      name: "post-compaction cleared",
      tokens: 25000,
      now: 3,
      compacted: true,
      patch: { completed: 3, baseline: 5000 },
      reason: undefined,
    },
  ];
  for (const c of cases) {
    const pi = {
      ...piState.initialState(c.compacted ? "compact-1" : null),
      ...c.patch,
    };
    assert.equal(piState.cooldownReason(pi, c.tokens, c.now), c.reason, `pi ${c.name}`);
    for (const [name, other] of [
      ["claude", claudeState],
      ["codex", codexState],
    ] as const) {
      const state = { ...other.initialState(c.compacted, c.now), ...c.patch };
      assert.equal(other.cooldownReason(state, c.tokens, c.now), c.reason, `${name} ${c.name}`);
    }
  }
});

test("both packages read the same COMPACT_ADVISER_DISABLE values the same way", () => {
  assert.equal(claudeDisable.DISABLE_ENV, piDisable.DISABLE_ENV);
  assert.equal(piDisable.DISABLE_ENV, "COMPACT_ADVISER_DISABLE");
  const truthy = ["1", "true", "TRUE", "True", "yes", "YES", "on", "ON", " on ", "\ttrue\n"];
  const falsy = ["0", "false", "no", "off", "", " ", "2", "1 0", "enabled", undefined];
  for (const value of [...truthy, ...falsy]) {
    assert.equal(
      claudeDisable.disabledByEnv(value),
      piDisable.disabledByEnv(value),
      `disagreed at ${JSON.stringify(value)}`,
    );
  }
  for (const value of truthy) assert.equal(piDisable.disabledByEnv(value), true, value);
  for (const value of falsy) assert.equal(piDisable.disabledByEnv(value), false, String(value));
});
