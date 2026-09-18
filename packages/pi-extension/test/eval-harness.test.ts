import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { mainBranch } from "../eval/branch.ts";
import { EXAMPLE_CORPUS_PATH, loadCorpus } from "../eval/corpus.ts";
import { futureWindow, renderEntry } from "../eval/render.ts";
import { loadSession, passesSizeGates, replayAt, settledEntries } from "../eval/replay.ts";
import { spread } from "../eval/sample.ts";
import { harness, temp } from "./helpers.ts";

test("corpus loader accepts the example contract and rejects a missing file", () => {
  const rows = loadCorpus(EXAMPLE_CORPUS_PATH);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].label, "interactive-1");
  assert.equal(rows[1].stratum, "coding");
  assert.match(rows[2].file, /<session>\.jsonl$/);
  assert.throws(() => loadCorpus(join("/tmp", "compact-adviser-missing-corpus.json")));
});

test("spread samples across the arc", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const got = spread(items, 3);
  assert.equal(got.length, 3);
  assert.ok(got[0] < got[1] && got[1] < got[2]);
  assert.deepEqual(spread(["a", "b"], 5), ["a", "b"]);
});

test("replay drives production snapshot from a synthetic Pi session", (t) => {
  const h = harness(t);
  const file = h.sm.getSessionFile();
  assert.ok(file);
  const s = loadSession(file);
  assert.ok(s.cwd);
  const settled = settledEntries(s);
  assert.ok(settled.length >= 2);
  const last = settled.at(-1);
  assert.ok(last);
  const cp = replayAt(s, last, settled.length - 1);
  assert.ok(cp);
  assert.equal(cp.sessionFile, file);
  assert.equal(cp.entryId, last.id);
  assert.ok(cp.contextTokens >= 40000);
  assert.ok(cp.conversationTokens > 20000);
  assert.equal(passesSizeGates(cp), true);
  const state = cp.state as {
    userConstraints: unknown[];
    recent: unknown[];
    coverage: { transcriptRecoverable: boolean };
  };
  assert.ok(Array.isArray(state.userConstraints));
  assert.ok(state.recent.length > 0);
  assert.equal(state.coverage.transcriptRecoverable, true);
  const branch = mainBranch(s);
  assert.ok(branch.some((e) => e.id === last.id));
  const future = futureWindow(branch, settled[0].id, 4);
  assert.ok(future.length > 0);
  assert.match(renderEntry(settled[0] as Record<string, unknown>, 40), /\[assistant/);
});

test("metrics.py scores synthetic labels without a live session", (t) => {
  const dir = join(temp(t), "metrics");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "labels.jsonl"),
    `${JSON.stringify({
      id: "cp001",
      phase_gold: "completed_checkpoint",
      continuation_gold: "recoverable",
      safe_to_compact: true,
      pivot: false,
      task_boundary: true,
    })}\n${JSON.stringify({
      id: "cp002",
      phase_gold: "still_in_progress",
      continuation_gold: "needs_older_details",
      safe_to_compact: false,
      pivot: false,
      task_boundary: false,
    })}\n`,
  );
  writeFileSync(
    join(dir, "checkpoints.jsonl"),
    `${JSON.stringify({ id: "cp001", sampling: "spread", stratum: "coding" })}\n${JSON.stringify({
      id: "cp002",
      sampling: "spread",
      stratum: "coding",
    })}\n`,
  );
  writeFileSync(
    join(dir, "results.jsonl"),
    `${JSON.stringify({
      id: "cp001",
      ok: true,
      model: "jev-test",
      phase: "completed_checkpoint",
      phaseP: { completed_checkpoint: 0.95, still_in_progress: 0.03, unclear: 0.02 },
      hint: true,
      auto: false,
    })}\n${JSON.stringify({
      id: "cp002",
      ok: true,
      model: "jev-test",
      phase: "still_in_progress",
      phaseP: { completed_checkpoint: 0.1, still_in_progress: 0.8, unclear: 0.1 },
      hint: false,
      auto: false,
    })}\n`,
  );
  const result = spawnSync(
    "python3",
    [
      join(process.cwd(), "eval/metrics.py"),
      join(dir, "labels.jsonl"),
      join(dir, "checkpoints.jsonl"),
      join(dir, "results.jsonl"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scored 2 checkpoints/);
  assert.match(result.stdout, /overall agreement: 2\/2/);
  assert.match(result.stdout, /TP=1 FP=0 FN=0 TN=1/);
  // Both gold definitions are reported side by side, and task-boundary recall
  // is its own section: a judge can look healthy overall and still miss the
  // moments the product exists to catch.
  assert.match(result.stdout, /=== product truth: gold is safe_to_compact ===/);
  assert.match(result.stdout, /=== contract: should-hint = completed \+ safe/);
  assert.match(result.stdout, /^ALL\s+2\s+1\s+0\s+100%\s+100%\s+0$/m);
  assert.match(result.stdout, /^ALL\s+2\s+1\s+0\s+1\s+100%\s+100%\s+1\s+1$/m);
  assert.match(result.stdout, /=== task-boundary recall/);
  assert.match(result.stdout, /^product truth\s+1\/1 = 100%\s+0\/0 = -$/m);
  assert.match(result.stdout, /^contract\s+1\/1 = 100%\s+0\/0 = -$/m);
});
