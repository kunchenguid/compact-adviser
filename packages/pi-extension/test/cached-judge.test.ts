import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { cachedJudge, cacheUsage, productionEvaluate } from "../eval/cached-judge.ts";
import { digest } from "../eval/dataset.ts";
import { partition } from "../eval/score-profile.ts";
import { parseJudgment } from "../src/judge.ts";
import { parseProfile } from "../src/profile.ts";
import { apiResponse } from "./helpers.ts";

function directory(t: TestContext): string {
  mkdirSync(".test-tmp", { recursive: true });
  const path = mkdtempSync(".test-tmp/cache-");
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const judgment = parseJudgment(apiResponse(1, 0));
const limits = {
  expectedModel: judgment.model,
  maxCalls: 2,
  maxInputTokens: 1_000_000,
  maxEstimatedUsd: 1,
  inputUsdPerMillion: 0.042,
  failedCallEstimateUsd: 0.01,
};

test("cached replay keys complete request bytes, reuses numeric profiles, and enforces ceilings", async (t) => {
  const root = directory(t);
  let calls = 0;
  const transport = async () => {
    calls++;
    return judgment;
  };
  const first = await cachedJudge(
    root,
    { text: "fixture" },
    "secret",
    limits,
    undefined,
    transport,
  );
  const profile = parseProfile(
    JSON.stringify({ version: 1, coordinationWeight: 0, floors: [[0, 0.6]] }),
  );
  assert.deepEqual(
    await cachedJudge(root, { text: "fixture" }, "secret", limits, profile, transport),
    first,
  );
  assert.equal(calls, 1);
  await cachedJudge(root, { text: "changed" }, "secret", limits, undefined, transport);
  await assert.rejects(
    cachedJudge(root, { text: "third" }, "secret", limits, undefined, transport),
    /ceiling/,
  );
  assert.equal(calls, 2);
  assert.equal(cacheUsage(root, limits).calls, 2);
  for (const hash of readdirSync(root)) {
    for (const file of readdirSync(join(root, hash))) {
      assert.ok(!readFileSync(join(root, hash, file), "utf8").includes("secret"));
    }
  }
});

test("failed calls retain estimated spend and stop after exactly one retry", async (t) => {
  const root = directory(t);
  let calls = 0;
  const transport = async () => {
    calls++;
    throw new Error("credential-must-not-appear");
  };
  const result = await cachedJudge(
    root,
    {},
    "credential-must-not-appear",
    limits,
    undefined,
    transport,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(
    await cachedJudge(root, {}, "credential-must-not-appear", limits, undefined, transport),
    result,
  );
  await assert.rejects(
    cachedJudge(root, { changed: true }, "key", limits, undefined, transport),
    /ceiling/,
  );
  assert.equal(calls, 2);
  assert.equal(cacheUsage(root, limits).estimatedUsd, 0.02);
  assert.equal(cacheUsage(root, limits).unknownUsageCalls, 2);
  const hash = readdirSync(root).find((name) =>
    readdirSync(join(root, name)).includes("result.json"),
  );
  assert.ok(hash);
  assert.ok(!readFileSync(join(root, hash, "result.json"), "utf8").includes("credential"));
});

test("corrupt persisted usage stops before another paid attempt", async (t) => {
  const root = directory(t);
  let calls = 0;
  const transport = async () => {
    calls++;
    return judgment;
  };
  await cachedJudge(root, {}, "key", limits, undefined, transport);
  const path = join(root, readdirSync(root)[0], "result.json");
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  receipt.judgment.inputTokens = "invalid";
  writeFileSync(path, JSON.stringify(receipt));
  await assert.rejects(
    cachedJudge(root, { changed: true }, "key", limits, undefined, transport),
    /accounting/,
  );
  assert.equal(calls, 1);
});

test("the cost guard blocks a retry that would exceed its failure allowance", async (t) => {
  const root = directory(t);
  let calls = 0;
  await assert.rejects(
    cachedJudge(root, {}, "key", { ...limits, maxEstimatedUsd: 0.015 }, undefined, async () => {
      calls++;
      throw new Error("failed");
    }),
    /ceiling/,
  );
  assert.equal(calls, 1);
  assert.equal(cacheUsage(root, limits).estimatedUsd, 0.01);
});

test("raw response capture preserves failed usage without exposing the key", async (t) => {
  const root = directory(t);
  const wire = { ...apiResponse(1, 0), answers: {}, echoed: "test-secret" };
  const result = await cachedJudge(
    root,
    {},
    "test-secret",
    limits,
    undefined,
    (state, key, profile, capture) =>
      productionEvaluate(
        state,
        key,
        profile,
        capture,
        async () => new Response(JSON.stringify(wire)),
      ),
  );
  assert.equal(result.ok, false);
  assert.equal(cacheUsage(root, limits).unknownUsageCalls, 0);
  const hash = readdirSync(root)[0];
  const raw = readFileSync(join(root, hash, "response.json"), "utf8");
  assert.ok(raw.includes("[REDACTED]"));
  assert.ok(!raw.includes("test-secret"));
  assert.ok(raw.includes("usage"));
  assert.equal(
    readFileSync(join(root, hash, "request.json"), "utf8"),
    readFileSync(join(root, hash, "retry/request.json"), "utf8"),
  );
});

test("model drift is recorded and prevents later scoring in the same ledger", async (t) => {
  const root = directory(t);
  let calls = 0;
  const transport = async () => {
    calls++;
    return { ...judgment, model: "changed-model" };
  };
  await assert.rejects(
    cachedJudge(root, {}, "key", limits, undefined, transport),
    /model identity changed/,
  );
  await assert.rejects(
    cachedJudge(root, { next: true }, "key", limits, undefined, transport),
    /model identity changed/,
  );
  assert.equal(calls, 1);
});

test("holdout unlock binds exact checkpoint bytes and rejects cross-split session groups", () => {
  const rows = [
    { id: "a", group: "one", split: "train", stratum: "coding", state: {} },
    { id: "b", group: "two", split: "holdout", stratum: "coding", state: {} },
  ];
  const text = rows.map((row) => JSON.stringify(row)).join("\n");
  assert.deepEqual(
    partition(text, "development").map((row) => row.id),
    ["a"],
  );
  assert.throws(() => partition(text, "holdout"), /locked/);
  const selection = { checkpointHash: digest(text), profile: "" };
  assert.deepEqual(
    partition(text, "holdout", selection).map((row) => row.id),
    ["b"],
  );
  assert.throws(() => partition(`${text}\n`, "holdout", selection), /locked/);
  rows[1].group = "one";
  assert.throws(
    () => partition(rows.map((row) => JSON.stringify(row)).join("\n"), "development"),
    /crosses/,
  );
});
