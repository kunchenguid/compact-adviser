/**
 * Every host package must ask TypeSafe the same question.
 *
 * Judge wording is tuned against the judgment-eval corpus, and a tuning pass
 * that lands in one package but not the others would silently ship different
 * products. These assertions compare what each package actually sends and
 * decides, not how any of the files is written.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as claudeDisable from "../../claude-mod/lib/disable.ts";
import * as claude from "../../claude-mod/lib/judge.ts";
import * as claudeLog from "../../claude-mod/lib/log.ts";
import * as claudeSnapshot from "../../claude-mod/lib/snapshot.ts";
import * as claudeState from "../../claude-mod/lib/state.ts";
import * as codexDisable from "../../codex-plugin/src/disable.ts";
import * as codex from "../../codex-plugin/src/judge.ts";
import * as codexLog from "../../codex-plugin/src/log.ts";
import * as codexRollout from "../../codex-plugin/src/rollout.ts";
import * as codexSnapshot from "../../codex-plugin/src/snapshot.ts";
import * as codexState from "../../codex-plugin/src/state.ts";
import * as grokDisable from "../../grok-plugin/lib/disable.ts";
import * as grok from "../../grok-plugin/lib/judge.ts";
import * as grokLog from "../../grok-plugin/lib/log.ts";
import * as grokSnapshot from "../../grok-plugin/lib/snapshot.ts";
import * as grokState from "../../grok-plugin/lib/state.ts";
import * as checkpoint from "../src/checkpoint.ts";
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
    assert.equal(grok.requestBody(s), pi.requestBody(s));
  }
});

test("the question set and the floor schedule match", () => {
  for (const other of [claude, codex, grok]) {
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
        ["grok", grok],
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
  assert.deepEqual(grok.parseJudgment(response), pi.parseJudgment(response));
  assert.equal(claude.qualifies(pi.parseJudgment(response), 0.2), true);
  for (const other of [claude, codex, grok]) {
    assert.equal(
      other.qualifies(pi.parseJudgment(response), 0.2),
      pi.qualifies(pi.parseJudgment(response), 0.2),
    );
  }
});

test("every package extracts the same written paths from the same shell commands", () => {
  const commands = [
    "echo hello > out.txt",
    "echo hello >> log.md",
    "echo hi >| clobber.txt",
    "cat in.txt | tee copy.txt",
    "tee -- out.txt",
    "tee -- -weird.txt",
    "sed -i 's/foo/bar/g' notes.md",
    "sed -i.bak -e 's/a/b/' file.txt",
    "sed -i.bak 's/a/b/' file.txt",
    "sed --in-place=.bak 's/a/b/' file.txt",
    "sed --in-place -e 's/a/b/' file.txt",
    "sed --in-place 's/a/b/' in-place-long.txt",
    "sed --in-place=.bak 's/a/b/' in-place-suffix.txt",
    "sed -i '' -e 's/a/b/' bsd.txt",
    "sed -i '' 's/a/b/' bsd.txt",
    "sed -i .bak -e 's/x/y/' f.txt",
    "sed -i .bak f.txt",
    "sed -ni -e 's/x/y/p' f.txt",
    "sed -Ei -e 's/x/y/' f.txt",
    "sed -ie 's/x/y/' f.txt",
    "sed -i --expression='s/x/y/' f.txt",
    "cat <<EOF\nfake > nope.txt\nEOF",
    'echo hi > "$TARGET"',
    "make 2> err.log",
    "run > out.log 2>&1",
    "echo done > /dev/null",
    "npm test",
    "mkdir -p x && echo hi > x/a.md && sed -i s/a/b/ x/a.md",
    "tee out.txt 2>/dev/null",
    "2>err.log tee out.txt",
    "cat x | tee log.txt 2>&1",
    "sed -i -e 's/a/b/' f.txt 2>/dev/null",
    "echo one > a.txt\necho two > b.txt",
    'git commit -m "fix parser\n\nbefore > after.txt was wrong"',
    "echo 'multi\nline > fake.txt\nend'",
    "if (( count > 0 )); then echo yes; fi",
    'if [[ "$ver" > "1.2" ]]; then echo newer; fi',
    "[[ a > b ]] && echo hi",
    "[[ a > b ]]; echo hi > real.txt",
    "echo $((count > 0)) > stat.txt",
    'for v in 1.0 2.0; do [[ "$v" > "1.2" ]] && echo newer; done',
    'while read l; do [[ "$l" > lim.txt ]] && echo; done < in',
    "{ [[ a > b.txt ]]; }",
    "if [ -f a ]; then tee out.txt; fi",
    "if [ -f a ]; then sed -i -e s/a/b/ notes.md; fi",
    "for i in 1; do tee t.txt; done",
    "{ tee brace.txt; }",
    "! tee negated.txt",
    "if :; then :; else sed -i -e s/a/b/ else.md; fi",
    "if :; then :; elif tee elif.txt; then :; fi",
    "if [ -f a ]; then cat out.txt; fi",
    "for tee in a b; do :; done",
    "if grep -q sed notes.md; then :; fi",
    "if for tee in a b; do :; done; then :; fi",
  ];
  const extractors = [
    claudeSnapshot.shellWrittenPaths,
    codexRollout.shellWrittenPaths,
    grokSnapshot.shellWrittenPaths,
    piContext.shellWrittenPaths,
  ];
  for (const command of commands) {
    const [first, ...rest] = extractors.map((extract) => extract(command));
    for (const [i, got] of rest.entries())
      assert.deepEqual(got, first, `${JSON.stringify(command)} extractor ${i + 1}`);
  }
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("echo hi > out.txt"), ["out.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("echo hi >| clobber.txt"), ["clobber.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("cat <<EOF\nfake > nope.txt\nEOF"), []);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("sed -i '' -e 's/a/b/' bsd.txt"), ["bsd.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("sed -i '' 's/a/b/' bsd.txt"), ["bsd.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("sed -i.bak 's/a/b/' file.txt"), ["file.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("sed --in-place=.bak 's/a/b/' file.txt"), [
    "file.txt",
  ]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("sed --in-place 's/a/b/' in-place-long.txt"), [
    "in-place-long.txt",
  ]);
  assert.deepEqual(
    claudeSnapshot.shellWrittenPaths("sed --in-place=.bak 's/a/b/' in-place-suffix.txt"),
    ["in-place-suffix.txt"],
  );
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("sed -i 's/a/b/' in-place-ambiguous.txt"), []);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("sed -i .bak -e 's/x/y/' f.txt"), ["f.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("sed -i .bak f.txt"), []);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("sed -i 's/foo/bar/g' notes.md"), []);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("sed -ni -e 's/x/y/p' f.txt"), ["f.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("sed -ie 's/x/y/' f.txt"), ["f.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("sed -i --expression='s/x/y/' f.txt"), [
    "f.txt",
  ]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("tee out.txt 2>/dev/null"), ["out.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("cat x | tee log.txt 2>&1"), ["log.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("tee -- out.txt"), ["out.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("tee -- -weird.txt"), []);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("sed -i -e 's/a/b/' f.txt 2>/dev/null"), [
    "f.txt",
  ]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("2>err.log tee out.txt"), ["out.txt"]);
  assert.deepEqual(
    claudeSnapshot.shellWrittenPaths('git commit -m "fix parser\n\nbefore > after.txt was wrong"'),
    [],
  );
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("echo 'multi\nline > fake.txt\nend'"), []);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("echo one > a.txt\necho two > b.txt"), [
    "a.txt",
    "b.txt",
  ]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("if (( count > 0 )); then echo yes; fi"), []);
  assert.deepEqual(
    claudeSnapshot.shellWrittenPaths('if [[ "$ver" > "1.2" ]]; then echo newer; fi'),
    [],
  );
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("[[ a > b ]] && echo hi"), []);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("[[ a > b ]]; echo hi > real.txt"), [
    "real.txt",
  ]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("echo $((count > 0)) > stat.txt"), [
    "stat.txt",
  ]);
  assert.deepEqual(
    claudeSnapshot.shellWrittenPaths('for v in 1.0 2.0; do [[ "$v" > "1.2" ]] && echo newer; done'),
    [],
  );
  assert.deepEqual(
    claudeSnapshot.shellWrittenPaths('while read l; do [[ "$l" > lim.txt ]] && echo; done < in'),
    [],
  );
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("{ [[ a > b.txt ]]; }"), []);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("if [ -f a ]; then tee out.txt; fi"), [
    "out.txt",
  ]);
  assert.deepEqual(
    claudeSnapshot.shellWrittenPaths("if [ -f a ]; then sed -i -e s/a/b/ notes.md; fi"),
    ["notes.md"],
  );
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("for i in 1; do tee t.txt; done"), ["t.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("{ tee brace.txt; }"), ["brace.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("! tee negated.txt"), ["negated.txt"]);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("if [ -f a ]; then cat out.txt; fi"), []);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("for tee in a b; do :; done"), []);
  assert.deepEqual(claudeSnapshot.shellWrittenPaths("if grep -q sed notes.md; then :; fi"), []);
  const longQuoted = `python3 -c 'payload${"\n".repeat(5000)}' > report.txt`;
  for (const extract of extractors) assert.deepEqual(extract(longQuoted), ["report.txt"]);
});

test("every package scrubs owned settings fields and known key values the same way", () => {
  const secret = "tsk-saved-key-must-not-leave";
  const dump = JSON.stringify({
    mode: "hint",
    typesafeApiKey: secret,
    "compact-adviser.typesafeApiKey": secret,
  });
  for (const other of [claudeSnapshot, codexSnapshot, grokSnapshot]) {
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
    [grokLog, grok],
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
  const rejudge =
    "Waiting for 20k new tokens, or 3 completed exchanges that change the context by 5k, since the last judgment";
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
      judgedTokens?: number | null;
      judgedAt?: number | null;
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
    {
      name: "re-ask gate: short of tokens and exchanges",
      tokens: 119999,
      now: 0,
      compacted: false,
      patch: { completed: 6, judgedTokens: 100000, judgedAt: 4 },
      reason: rejudge,
    },
    {
      name: "re-ask gate: 20k more tokens",
      tokens: 120000,
      now: 0,
      compacted: false,
      patch: { completed: 5, judgedTokens: 100000, judgedAt: 4 },
      reason: undefined,
    },
    {
      name: "re-ask gate: 3 more exchanges and 5k more tokens",
      tokens: 105000,
      now: 0,
      compacted: false,
      patch: { completed: 7, judgedTokens: 100000, judgedAt: 4 },
      reason: undefined,
    },
    {
      name: "re-ask gate: 3 more exchanges that barely changed the context",
      tokens: 104999,
      now: 0,
      compacted: false,
      patch: { completed: 9, judgedTokens: 100000, judgedAt: 4 },
      reason: rejudge,
    },
    {
      name: "re-ask gate: 3 more exchanges after the context shrank 5k",
      tokens: 95000,
      now: 0,
      compacted: false,
      patch: { completed: 7, judgedTokens: 100000, judgedAt: 4 },
      reason: undefined,
    },
    {
      name: "re-ask gate: context shrank",
      tokens: 90000,
      now: 0,
      compacted: false,
      patch: { completed: 5, judgedTokens: 100000, judgedAt: 4 },
      reason: rejudge,
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
    const grok = { ...grokState.initialState(c.compacted, c.now), ...c.patch };
    assert.equal(grokState.cooldownReason(grok, c.tokens, c.now), c.reason, `grok ${c.name}`);
  }
});

test("every package ships the same checkpoint policy file", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const pi = read("../src/checkpoint.ts");
  for (const path of [
    "../../claude-mod/lib/checkpoint.ts",
    "../../codex-plugin/src/checkpoint.ts",
    "../../grok-plugin/lib/checkpoint.ts",
  ])
    assert.equal(read(path), pi, path);
});

test("a verdict resolves and updates the gates the same way for every mode", () => {
  const cases: Array<{
    fresh: boolean;
    qualifies: boolean;
    mode: "hint" | "auto" | "off";
    autoAcknowledged: boolean;
    resolution: checkpoint.Resolution;
    judged: [number | null, number | null];
    hint: [number | null, string | null];
  }> = [
    {
      fresh: false,
      qualifies: true,
      mode: "hint",
      autoAcknowledged: false,
      resolution: "discard",
      judged: [90000, 1],
      hint: [null, null],
    },
    {
      fresh: true,
      qualifies: true,
      mode: "off",
      autoAcknowledged: true,
      resolution: "discard",
      judged: [90000, 1],
      hint: [null, null],
    },
    {
      fresh: true,
      qualifies: false,
      mode: "hint",
      autoAcknowledged: false,
      resolution: "wait",
      judged: [150000, 4],
      hint: [null, null],
    },
    {
      fresh: true,
      qualifies: false,
      mode: "auto",
      autoAcknowledged: true,
      resolution: "wait",
      judged: [150000, 4],
      hint: [null, null],
    },
    {
      fresh: true,
      qualifies: true,
      mode: "auto",
      autoAcknowledged: false,
      resolution: "unconfirmed",
      judged: [150000, 4],
      hint: [null, null],
    },
    {
      fresh: true,
      qualifies: true,
      mode: "hint",
      autoAcknowledged: false,
      resolution: "hint",
      judged: [null, null],
      hint: [4, "fp"],
    },
    {
      fresh: true,
      qualifies: true,
      mode: "auto",
      autoAcknowledged: true,
      resolution: "compact",
      judged: [null, null],
      hint: [null, null],
    },
  ];
  const before = {
    ...piState.initialState(null),
    completed: 4,
    failures: 2,
    retryAfter: 9,
    judgedTokens: 90000,
    judgedAt: 1,
  };
  for (const c of cases) {
    const name = `${c.mode} fresh=${c.fresh} qualifies=${c.qualifies} ack=${c.autoAcknowledged}`;
    const resolution = checkpoint.resolve(c);
    assert.equal(resolution, c.resolution, name);
    const after = checkpoint.judged(before, resolution, 150000, "fp");
    assert.deepEqual(
      [
        after.failures,
        after.retryAfter,
        after.judgedTokens,
        after.judgedAt,
        after.lastHintAt,
        after.lastHintKey,
      ],
      [0, 0, ...c.judged, ...c.hint],
      name,
    );
  }
});

test("Pi restores pre-gate and invalid gate entries like every other package", () => {
  const entry = (data: Record<string, unknown>) =>
    [{ type: "custom", customType: piState.STATE_TYPE, data }] as never;
  const legacy = {
    version: 1,
    compactionId: null,
    baseline: null,
    completed: 2,
    lastSettled: null,
    lastHintAt: null,
    lastHintKey: null,
    snoozeUntil: 0,
    retryAfter: 0,
    failures: 0,
  };
  const restored = piState.restoreState(entry(legacy));
  assert.deepEqual(
    [restored.snoozeUntil, restored.judgedTokens, restored.judgedAt],
    [0, null, null],
  );
  for (const bad of [
    { judgedAt: -1 },
    { judgedTokens: -1 },
    { judgedTokens: Number.NaN },
    { judgedTokens: "9" },
  ])
    assert.equal(
      piState.restoreState(entry({ ...legacy, ...bad })).snoozeUntil,
      3,
      JSON.stringify(bad),
    );
});

test("every package restores pre-gate records the same way", () => {
  const legacy = {
    version: 1,
    compacted: false,
    baseline: null,
    completed: 2,
    lastHintAt: null,
    lastHintKey: null,
    snoozeUntil: 0,
    retryAfter: 0,
    failures: 0,
    updatedAt: 0,
  };
  for (const [name, other] of [
    ["claude", claudeState],
    ["codex", codexState],
    ["grok", grokState],
  ] as const) {
    const restored = other.restoreState(legacy, 0);
    assert.deepEqual(
      [restored.snoozeUntil, restored.judgedTokens, restored.judgedAt],
      [0, null, null],
      `${name} legacy`,
    );
    for (const bad of [
      { judgedAt: -1 },
      { judgedTokens: -1 },
      { judgedTokens: Number.NaN },
      { judgedTokens: "9" },
    ])
      assert.equal(
        other.restoreState({ ...legacy, ...bad }, 0).snoozeUntil,
        3,
        `${name} ${JSON.stringify(bad)}`,
      );
  }
});

test("every package reads the same COMPACT_ADVISER_DISABLE values the same way", () => {
  assert.equal(piDisable.DISABLE_ENV, "COMPACT_ADVISER_DISABLE");
  const truthy = ["1", "true", "TRUE", "True", "yes", "YES", "on", "ON", " on ", "\ttrue\n"];
  const falsy = ["0", "false", "no", "off", "", " ", "2", "1 0", "enabled", undefined];
  for (const value of [...truthy, ...falsy]) {
    for (const other of [claudeDisable, codexDisable, grokDisable]) {
      assert.equal(other.DISABLE_ENV, piDisable.DISABLE_ENV);
      assert.equal(
        other.disabledByEnv(value),
        piDisable.disabledByEnv(value),
        `disagreed at ${JSON.stringify(value)}`,
      );
    }
  }
  for (const value of truthy) assert.equal(piDisable.disabledByEnv(value), true, value);
  for (const value of falsy) assert.equal(piDisable.disabledByEnv(value), false, String(value));
});
