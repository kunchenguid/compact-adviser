/**
 * The Pi extension and the Claude mod must ask TypeSafe the same question.
 *
 * Judge wording is tuned against the judgment-eval corpus, and a tuning pass
 * that lands in one package but not the other would silently ship two
 * different products. These assertions compare what each package actually
 * sends and decides, not how either file is written.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as claude from "../../claude-mod/lib/judge.ts";
import * as claudeSnapshot from "../../claude-mod/lib/snapshot.ts";
import * as piContext from "../src/context.ts";
import * as pi from "../src/judge.ts";

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

test("both packages send byte-identical request bodies", () => {
  for (const s of [state, { ...state, recent: [] }, {}, null]) {
    assert.equal(claude.requestBody(s), pi.requestBody(s));
  }
});

test("the question set and the floor schedule match", () => {
  assert.deepEqual(claude.QUESTIONS, pi.QUESTIONS);
  assert.deepEqual(Object.keys(pi.QUESTIONS), ["done", "shape"]);
  assert.equal(claude.FLOOR_MAX, pi.FLOOR_MAX);
  assert.equal(claude.FLOOR_MIN, pi.FLOOR_MIN);
  assert.equal(claude.USAGE_STRICT_UNTIL, pi.USAGE_STRICT_UNTIL);
  assert.equal(claude.USAGE_LOOSE_AT, pi.USAGE_LOOSE_AT);
  assert.equal(pi.USAGE_STRICT_UNTIL, 0.1);
  assert.equal(pi.USAGE_LOOSE_AT, 0.9);
  assert.equal(pi.FLOOR_MIN, 0.5);
  for (let u = -0.1; u <= 1.1; u += 0.01) assert.equal(claude.floorFor(u), pi.floorFor(u));
  assert.equal(claude.floorFor(Number.NaN), pi.floorFor(Number.NaN));
  assert.equal(claude.ENDPOINT, pi.ENDPOINT);
  assert.equal(claude.MAX_REQUEST_BYTES, pi.MAX_REQUEST_BYTES);
});

test("both packages score and gate the same judgments the same way", () => {
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
      assert.equal(claude.score(judgment), pi.score(judgment));
      for (const usage of [Number.NaN, 0, 0.3, 0.5, 0.7, 0.85, 1]) {
        assert.equal(
          claude.qualifies(judgment, usage),
          pi.qualifies(judgment, usage),
          `disagreed at finished=${finished} handsOn=${handsOn} usage=${usage}`,
        );
      }
    }
  }
});

test("both packages parse the same wire response into the same judgment", () => {
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
  assert.equal(claude.qualifies(pi.parseJudgment(response), 0.2), true);
  assert.equal(
    claude.qualifies(pi.parseJudgment(response), 0.2),
    pi.qualifies(pi.parseJudgment(response), 0.2),
  );
});

test("both packages scrub owned settings fields and known key values the same way", () => {
  const secret = "tsk-saved-key-must-not-leave";
  const dump = JSON.stringify({
    mode: "hint",
    typesafeApiKey: secret,
    "compact-adviser.typesafeApiKey": secret,
  });
  assert.deepEqual(claudeSnapshot.redact(dump), piContext.redact(dump));
  assert.deepEqual(claudeSnapshot.redactOwnedSettings(dump), piContext.redactOwnedSettings(dump));
  assert.deepEqual(
    claudeSnapshot.scrubKnownSecrets(`keep ${secret} nearby`, [secret]),
    piContext.scrubKnownSecrets(`keep ${secret} nearby`, [secret]),
  );
  assert.ok(!claudeSnapshot.redact(dump).text.includes(secret));
  assert.ok(claudeSnapshot.redact(dump).text.includes("hint"));
});
