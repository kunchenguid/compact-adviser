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

test("the question set and the qualifying floor match", () => {
  assert.deepEqual(claude.QUESTIONS, pi.QUESTIONS);
  assert.equal(claude.QUALIFY_FLOOR, pi.QUALIFY_FLOOR);
  assert.equal(claude.ENDPOINT, pi.ENDPOINT);
  assert.equal(claude.MAX_REQUEST_BYTES, pi.MAX_REQUEST_BYTES);
});

test("both packages gate the same judgments the same way", () => {
  const classes = Object.keys(pi.QUESTIONS.phase.criteria);
  for (const choice of classes) {
    for (const p of [0, 0.5, 0.89, 0.895, 0.9, 0.95, 1]) {
      const rest = (1 - p) / (classes.length - 1);
      const probabilities = Object.fromEntries(
        classes.map((c) => [c, c === "completed_checkpoint" ? p : rest]),
      );
      const judgment = {
        phase: { choice, probabilities, confidence: p },
        model: "jev-test",
        inputTokens: 1,
        outputTokens: 1,
      };
      assert.equal(
        claude.qualifies(judgment),
        pi.qualifies(judgment),
        `disagreed on ${choice} at p=${p}`,
      );
    }
  }
});

test("both packages parse the same wire response into the same judgment", () => {
  const response = {
    model: "jev-1.13.0",
    answers: {
      phase: {
        type: "choice",
        choice: "completed_checkpoint",
        probabilities: { completed_checkpoint: 0.93, still_in_progress: 0.06, unclear: 0.01 },
        confidence: 0.88,
      },
    },
    usage: { input_tokens: 7440, output_tokens: 44 },
  };
  assert.deepEqual(claude.parseJudgment(response), pi.parseJudgment(response));
  assert.equal(claude.qualifies(pi.parseJudgment(response)), true);
});
