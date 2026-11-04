import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { QUESTIONS } from "../lib/judge.ts";
import { HINT } from "../lib/statusline.ts";
import {
  lab,
  runCli,
  statusPayload,
  stopPayload,
  typesafeFixture,
  workedHistory,
  writeHistory,
  writeSignals,
} from "./support.ts";

function reply() {
  return {
    model: "gpt-6-luna",
    answers: Object.entries(QUESTIONS).map(([name, question]) => ({
      name,
      type: "choice",
      choice: Object.keys(question.criteria)[0],
      confidence: 1,
      probabilities: Object.keys(question.criteria).map((value, i) => ({
        value,
        probability: i === 0 ? 1 : 0,
      })),
    })),
    usage: { input_tokens: 123, output_tokens: 0 },
  };
}

test("Grok Decisions uses only the selected key and exact logged wire body through the real CLI", async (t) => {
  const l = lab(t);
  const fixture = await typesafeFixture(t);
  fixture.reply = reply();
  writeHistory(l, workedHistory("openai-fixture-key inactive-fixture-key"));
  writeSignals(l, 150000);
  const env = {
    COMPACT_ADVISER_PROVIDER: "openai-decisions",
    OPENAI_API_KEY: "openai-fixture-key",
    TYPESAFE_API_KEY: "inactive-fixture-key",
    TYPESAFE_BASE: "invalid",
    COMPACT_ADVISER_TEST_ENDPOINT: fixture.url.replace("systemone", "decisions"),
  };
  await runCli(["log", "on"], { lab: l, env });
  const result = await runCli(["hook", "stop"], { lab: l, env, stdin: stopPayload(l) });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(fixture.bodies.length, 1);
  assert.deepEqual(fixture.requests, [
    { url: "/v1/decisions", authorization: "Bearer openai-fixture-key" },
  ]);
  assert.ok(!fixture.bodies[0]?.includes("fixture-key"));
  const body = JSON.parse(fixture.bodies[0] ?? "{}");
  assert.equal(body.model, "gpt-6-luna");
  assert.deepEqual(
    body.questions.map((q: { name: string }) => q.name),
    ["done", "shape"],
  );
  assert.ok(
    (await runCli(["status-line"], { lab: l, env, stdin: statusPayload(l) })).stdout.includes(HINT),
  );
  const status = await runCli(["status"], { lab: l, env });
  assert.match(status.stdout, /OpenAI Decisions.*experimental/);
  assert.match(status.stdout, /Key: env/);
  const log = readFileSync(
    join(l.dataDir, `compact-adviser-requests-${l.sessionId}.jsonl`),
    "utf8",
  );
  const lines = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(lines[0].body, body);
  assert.equal(lines[0].provider, "openai-decisions");
  assert.equal(lines[1].provider, "openai-decisions");
  assert.ok(!log.includes("fixture-key"));
});

for (const selection of ["openai-decisions", "invalid"]) {
  test(`Grok ${selection} never falls back to a TypeSafe saved/env/dotenv key`, async (t) => {
    const l = lab(t);
    const fixture = await typesafeFixture(t);
    writeHistory(l, workedHistory());
    writeSignals(l, 150000);
    writeFileSync(
      join(l.cwd, ".env"),
      "TYPESAFE_API_KEY=dotenv-fixture\nOPENAI_API_KEY=ignored-fixture\n",
    );
    await runCli(["key", "saved-fixture"], { lab: l });
    const env = {
      COMPACT_ADVISER_PROVIDER: selection,
      TYPESAFE_API_KEY: "env-fixture",
      COMPACT_ADVISER_TEST_ENDPOINT: fixture.url,
    };
    await runCli(["hook", "stop"], { lab: l, env, stdin: stopPayload(l) });
    assert.equal(fixture.bodies.length, 0);
    assert.ok(
      !(await runCli(["status-line"], { lab: l, env, stdin: statusPayload(l) })).stdout.includes(
        HINT,
      ),
    );
    assert.match((await runCli(["status"], { lab: l, env })).stdout, /Key: missing/);
  });
}

for (const [name, status, response, kind] of [
  [
    "refusal",
    200,
    { ...reply(), answers: [{ type: "refusal", name: "done" }, reply().answers[1]] },
    "response",
  ],
  ["authentication", 401, { error: { message: "secret" } }, "authentication"],
  ["rate limit", 429, { error: { type: "rate_limit_error" } }, "rate-limit"],
  ["quota", 429, { error: { type: "insufficient_quota" } }, "billing"],
] as const) {
  test(`Grok Decisions ${name} is silent and retains provider provenance across processes`, async (t) => {
    const l = lab(t);
    const fixture = await typesafeFixture(t);
    fixture.reply = response;
    fixture.status = status;
    writeHistory(l, workedHistory());
    writeSignals(l, 150000);
    const env = {
      COMPACT_ADVISER_PROVIDER: "openai-decisions",
      OPENAI_API_KEY: "fixture",
      COMPACT_ADVISER_TEST_ENDPOINT: fixture.url,
    };
    await runCli(["hook", "stop"], { lab: l, env, stdin: stopPayload(l) });
    assert.equal(fixture.bodies.length, 1);
    assert.ok(
      !(await runCli(["status-line"], { lab: l, stdin: statusPayload(l) })).stdout.includes(HINT),
    );
    const result = await runCli(["status"], { lab: l });
    assert.match(result.stdout, new RegExp(`Last OpenAI Decisions outcome: ${kind}`));
    assert.doesNotMatch(result.stdout, /secret/);
  });
}
