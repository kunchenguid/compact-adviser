import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { cachedJudge, cacheUsage, productionEvaluate } from "../eval/cached-judge.ts";
import { digest } from "../eval/dataset.ts";
import { partition } from "../eval/score-profile.ts";
import { parseJudgment, requestBody } from "../src/judge.ts";
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

test("Decisions replay caches its actual wire bytes and preserves provider/model identity", async (t) => {
  const root = directory(t);
  const old = apiResponse();
  const response = {
    ...old,
    model: "gpt-6-luna",
    answers: Object.entries(old.answers).map(([name, a]) => ({
      ...a,
      name,
      probabilities: Object.entries(a.probabilities).map(([value, probability]) => ({
        value,
        probability,
      })),
    })),
  };
  let calls = 0;
  const state = { text: "Synthetic completed work." };
  const evaluate = async () =>
    productionEvaluate(
      state,
      "synthetic-key",
      undefined,
      undefined,
      async (url, init) => {
        calls++;
        assert.equal(url, "https://api.openai.com/v1/decisions");
        assert.equal(init?.body, requestBody(state, undefined, "openai-decisions"));
        return new Response(JSON.stringify(response));
      },
      "openai-decisions",
    );
  const budget = { ...limits, expectedModel: "gpt-6-luna" };
  const first = await cachedJudge(
    root,
    state,
    "synthetic-key",
    budget,
    undefined,
    evaluate,
    "openai-decisions",
  );
  assert.equal(first.requestHash, digest(requestBody(state, undefined, "openai-decisions")));
  assert.deepEqual(
    await cachedJudge(
      root,
      state,
      "synthetic-key",
      budget,
      undefined,
      evaluate,
      "openai-decisions",
    ),
    first,
  );
  assert.equal(calls, 1);
  const saved = readFileSync(join(root, readdirSync(root)[0] ?? "", "request.json"), "utf8");
  assert.equal(saved, requestBody(state, undefined, "openai-decisions"));
  await assert.rejects(
    cachedJudge(root, state, "synthetic-key", limits, undefined, evaluate, "openai-decisions"),
    /expectedModel/,
  );
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

test("zero retries reuse only the first attempt while retaining all historical accounting", async (t) => {
  for (const provider of ["typesafe", "openai-decisions"] as const) {
    const root = directory(t);
    const budget = {
      ...limits,
      expectedModel: provider === "typesafe" ? judgment.model : "gpt-6-luna",
      maxRetries: 0 as const,
    };
    let calls = 0;
    const transport = async () => {
      calls++;
      if (calls === 1) throw new Error("synthetic failure");
      return { ...judgment, model: budget.expectedModel };
    };
    const first = await cachedJudge(
      root,
      {},
      "synthetic-key",
      budget,
      undefined,
      transport,
      provider,
    );
    assert.equal(first.ok, false);
    assert.deepEqual(
      await cachedJudge(root, {}, "synthetic-key", budget, undefined, transport, provider),
      first,
    );
    assert.equal(calls, 1);
    assert.equal(cacheUsage(root, budget).estimatedUsd, 0.01);
    assert.equal(cacheUsage(root, budget).unknownUsageCalls, 1);
    const retried = await cachedJudge(
      root,
      {},
      "synthetic-key",
      { ...budget, maxRetries: 1 },
      undefined,
      transport,
      provider,
    );
    assert.equal(retried.ok, true);
    assert.equal(calls, 2);
    assert.deepEqual(
      await cachedJudge(root, {}, "synthetic-key", budget, undefined, transport, provider),
      first,
    );
    assert.equal(calls, 2);
    assert.equal(cacheUsage(root, budget).calls, 2);
    assert.equal(cacheUsage(root, budget).unknownUsageCalls, 1);
  }
});

test("invalid retry limits fail before transport or cache writes", async (t) => {
  const root = directory(t);
  let calls = 0;
  for (const maxRetries of [null, false, "0", -1, 2, 0.5]) {
    const invalidLimits = JSON.parse(JSON.stringify({ ...limits, maxRetries }));
    await assert.rejects(
      cachedJudge(root, {}, "synthetic-key", invalidLimits, undefined, async () => {
        calls++;
        return judgment;
      }),
      /maxRetries/,
    );
  }
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(root), []);
});

test("replay CLI honors zero retries and preserves default request counts", async (t) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(body);
      response.writeHead(503, { Connection: "close" });
      response.end("Synthetic judge unavailable");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const maxRetries of [undefined, 0]) {
    const root = directory(t);
    const checkpoints = join(root, "checkpoints.jsonl");
    const limitsFile = join(root, "limits.json");
    const preload = join(root, "loopback-only.mjs");
    writeFileSync(
      preload,
      `
      const localFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        if (url !== "https://api.typesafe.ai/v1/systemone") throw new Error("Unexpected fixture endpoint");
        return localFetch("http://127.0.0.1:${address.port}/v1/systemone", init);
      };
    `,
    );
    const rows = ["first", "second"].map((id) => ({
      id,
      group: id,
      split: "train",
      stratum: "synthetic",
      state: { checkpoint: id },
    }));
    writeFileSync(checkpoints, rows.map((row) => JSON.stringify(row)).join("\n"));
    writeFileSync(limitsFile, JSON.stringify({ ...limits, maxCalls: 4, maxRetries }));
    const before = requests.length;
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(resolve(preload)).href,
        "--import",
        "tsx",
        "eval/score-profile.ts",
        checkpoints,
        root,
        "development",
        limitsFile,
        "--execute",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          COMPACT_ADVISER_PROVIDER: "typesafe",
          TYPESAFE_API_KEY: "synthetic-replay-key",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, output);
    const calls = requests.length - before;
    t.diagnostic(
      `maxRetries=${maxRetries ?? "omitted"}: ${calls} HTTP requests for two checkpoints`,
    );
    const expectedAttempts = maxRetries === 0 ? 1 : 2;
    assert.equal(calls, 2 * expectedAttempts);
    for (const row of rows) {
      assert.equal(
        requests
          .slice(before)
          .filter((body) => JSON.stringify(JSON.parse(body).state) === JSON.stringify(row.state))
          .length,
        expectedAttempts,
      );
    }
    const results = readFileSync(join(root, `development-${digest("")}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(results.length, 2);
    assert.ok(results.every((row) => row.ok === false && row.hint === false && row.auto === false));
    assert.equal(cacheUsage(join(root, "cache"), limits).calls, calls);
  }
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
