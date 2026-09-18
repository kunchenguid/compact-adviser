import assert from "node:assert/strict";
import { readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { lockSync } from "proper-lockfile";
import { ConfigStore, DEFAULT_CONFIG, parseMinimum } from "../src/config.ts";
import { RECENT_TAIL_MESSAGES, snapshot } from "../src/context.ts";
import { parseDotenvKey, resolveTypesafeApiKey } from "../src/env.ts";
import {
  ENDPOINT,
  JUDGE_UNAVAILABLE_MESSAGE,
  JudgeError,
  judge,
  judgeErrorMessage,
  MAX_REQUEST_BYTES,
  parseJudgment,
  QUALIFY_FLOOR,
  qualifies,
  requestBody,
} from "../src/judge.ts";
import { apiResponse, assistant, harness, temp, toolResult } from "./helpers.ts";

test("config defaults, atomic persistence, field merging, contention and invalid files", (t) => {
  const dir = temp(t),
    a = new ConfigStore(dir),
    b = new ConfigStore(dir);
  assert.deepEqual(a.read(), DEFAULT_CONFIG);
  a.update({ mode: "auto", autoAcknowledged: true });
  b.update({ minContextTokens: 60000 });
  assert.equal(a.read().mode, "auto");
  assert.equal(a.read().minContextTokens, 60000);
  assert.equal(statSync(a.path).mode & 0o777, 0o600);
  const release = lockSync(a.path, { realpath: false });
  assert.throws(() => b.update({ mode: "off" }));
  release();
  assert.equal(a.read().mode, "auto");
  const previous = readFileSync(a.path, "utf8");
  assert.throws(() => a.update({ minContextTokens: 0 }));
  assert.equal(readFileSync(a.path, "utf8"), previous);
  writeFileSync(a.path, JSON.stringify({ ...DEFAULT_CONFIG, version: 2 }));
  assert.throws(() => a.read());
  assert.throws(() => a.update({ mode: "hint" }));
  const target = join(dir, "elsewhere");
  writeFileSync(target, JSON.stringify(DEFAULT_CONFIG));
  unlinkSync(a.path);
  symlinkSync(target, a.path);
  assert.throws(() => a.read());
  assert.throws(() => a.update({ mode: "off" }));
  assert.equal(JSON.parse(readFileSync(target, "utf8")).mode, "hint");
  unlinkSync(a.path);
  writeFileSync(
    a.path,
    JSON.stringify({
      version: 1,
      mode: "off",
      minContextTokens: 50000,
      sharingConsent: false,
      autoAcknowledged: true,
    }),
  );
  assert.deepEqual(a.read(), {
    version: 1,
    mode: "off",
    minContextTokens: 50000,
    autoAcknowledged: true,
    logRequests: false,
  });
  a.update({ mode: "hint" });
  assert.equal("sharingConsent" in JSON.parse(readFileSync(a.path, "utf8")), false);
});

test("minimum parsing rejects ambiguous, nonpositive or unsafe values", () => {
  assert.equal(parseMinimum(" 40000 "), 40000);
  for (const value of ["", "0", "-1", "1.5", "40k", "4e4", "NaN", "Infinity", "9007199254740992"])
    assert.throws(() => parseMinimum(value), value);
});

test("bounded snapshot excludes system prompt, thinking, images and known secrets", (t) => {
  const h = harness(t);
  h.sm.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "API_KEY=secretvalue123 preserve the requirement" },
      { type: "image", data: "IMAGESECRET", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });
  h.sm.appendMessage({
    ...assistant("Saved"),
    content: [
      { type: "thinking", thinking: "INTERNALSECRET" },
      { type: "text", text: "Saved. Bearer fixtureSecretToken" },
    ],
  });
  const result = snapshot(h.ctx),
    body = requestBody(result.state);
  assert.ok(Buffer.byteLength(body) <= MAX_REQUEST_BYTES);
  assert.ok(!body.includes("SYSTEM_SECRET_NOT_EXPORTED"));
  assert.ok(!body.includes("secretvalue123"));
  assert.ok(!body.includes("fixtureSecretToken"));
  assert.ok(!body.includes("IMAGESECRET"));
  assert.ok(!body.includes("INTERNALSECRET"));
  assert.equal(result.state.coverage.hasImages, true);
  assert.equal(result.autoCoverage, false);
});

test("recent tail keeps the last 64 messages and still clips to byte budgets", (t) => {
  const h = harness(t);
  const markers = Array.from({ length: 80 }, (_, i) => `unique-tail-${i}`);
  for (const marker of markers) h.sm.appendMessage(assistant(marker));
  const view = snapshot(h.ctx);
  const recentText = view.state.recent.map((m) => m.text).join("\n");
  for (const marker of markers.slice(-RECENT_TAIL_MESSAGES)) assert.ok(recentText.includes(marker));
  assert.ok(!recentText.includes(markers[0] ?? ""));
  assert.ok(view.state.recent.filter((m) => m.role !== "user").length > 6);
  assert.equal(view.state.coverage.recentTextTruncated, false);
  assert.ok(view.state.coverage.olderMessagesOmitted > 0);
  h.sm.appendMessage(assistant("Z".repeat(20000)));
  const clipped = snapshot(h.ctx);
  assert.equal(clipped.state.coverage.recentTextTruncated, true);
  assert.ok(Buffer.byteLength(requestBody(clipped.state)) <= MAX_REQUEST_BYTES);
});

test("tool results count in the 64-message window and long dumps keep a head and tail", (t) => {
  const h = harness(t);
  const huge = `TOOLHEAD${"m".repeat(4000)}TOOLMID${"n".repeat(4000)}TOOLTAIL`;
  h.sm.appendMessage(assistant("SIBLING-OLD"));
  h.sm.appendMessage(toolResult(huge));
  h.sm.appendMessage(assistant("SIBLING-NEW"));
  const view = snapshot(h.ctx);
  const recentText = view.state.recent.map((m) => m.text).join("\n");
  const tool = view.state.recent.find((m) => m.role === "toolResult");
  assert.ok(recentText.includes("SIBLING-OLD"));
  assert.ok(recentText.includes("SIBLING-NEW"));
  assert.ok(tool);
  assert.ok(tool.text.includes("TOOLHEAD"));
  assert.ok(tool.text.includes("TOOLTAIL"));
  assert.ok(/\[truncated \d+ bytes\]/.test(tool.text));
  assert.ok(!tool.text.includes("TOOLMID"));
  assert.ok(Buffer.byteLength(tool.text) <= 512);
  assert.ok(Buffer.byteLength(requestBody(view.state)) <= MAX_REQUEST_BYTES);
  h.sm.appendMessage(toolResult("OUTSIDE-WINDOW"));
  for (let i = 0; i < RECENT_TAIL_MESSAGES; i++) h.sm.appendMessage(assistant(`pad-${i}`));
  const omitted = snapshot(h.ctx);
  assert.ok(!omitted.state.recent.some((m) => m.text.includes("OUTSIDE-WINDOW")));
});

test("request contains typed factors; output validation rejects malformed/contradictory confidence evidence", () => {
  const valid = parseJudgment(apiResponse());
  assert.equal(QUALIFY_FLOOR, 0.9);
  assert.ok(qualifies(valid));
  const atFloor = {
    ...valid,
    phase: {
      ...valid.phase,
      probabilities: { completed_checkpoint: 0.9, still_in_progress: 0.05, unclear: 0.05 },
    },
  };
  const belowFloor = {
    ...valid,
    phase: {
      ...valid.phase,
      probabilities: { completed_checkpoint: 0.89, still_in_progress: 0.06, unclear: 0.05 },
    },
  };
  assert.ok(qualifies(atFloor));
  assert.ok(!qualifies(belowFloor));
  const bad = apiResponse();
  bad.answers.phase.probabilities.completed_checkpoint = 0.6;
  assert.throws(() => parseJudgment(bad));
  assert.throws(() => parseJudgment({}));
  assert.throws(() => requestBody({ text: "x".repeat(MAX_REQUEST_BYTES) }));
});

test("HTTP contract, output bound, status classification, and cancellation", async () => {
  let seen: RequestInit | undefined;
  let url: unknown;
  const transport = (async (input, init) => {
    url = input;
    seen = init;
    return new Response(JSON.stringify(apiResponse()), { status: 200 });
  }) as typeof fetch;
  const result = await judge(
    { phase: "done" },
    "fake-test-key",
    new AbortController().signal,
    transport,
  );
  assert.equal(url, ENDPOINT);
  assert.equal(result.inputTokens, 2000);
  assert.equal(seen?.redirect, "error");
  const headers = seen?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer fake-test-key");
  assert.ok(!String(seen?.body).includes("fake-test-key"));
  const body = JSON.parse(String(seen?.body));
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body.questions), ["phase"]);
  for (const [status, kind] of [
    [401, "authentication"],
    [429, "rate-limit"],
    [529, "server"],
  ] as const) {
    await assert.rejects(
      judge(
        {},
        "x",
        new AbortController().signal,
        (async () => new Response("error", { status })) as typeof fetch,
      ),
      (error: unknown) =>
        error instanceof JudgeError &&
        error.kind === kind &&
        error.message === judgeErrorMessage(kind),
    );
  }
  await assert.rejects(
    judge(
      {},
      "x",
      new AbortController().signal,
      (async () => new Response("x".repeat(40000))) as typeof fetch,
    ),
    (error: unknown) =>
      error instanceof JudgeError &&
      error.kind === "response" &&
      error.message === judgeErrorMessage("response"),
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    judge({}, "x", aborted.signal, (async (_url, init) => {
      init?.signal?.throwIfAborted();
      throw new Error("unexpected");
    }) as typeof fetch),
    (error: unknown) =>
      error instanceof JudgeError &&
      error.kind === "network" &&
      error.message === judgeErrorMessage("network"),
  );
});

test("judgment-failure notices explain the skip and which kinds can be temporary", () => {
  for (const kind of ["timeout", "network", "rate-limit", "server", "response"] as const) {
    const message = judgeErrorMessage(kind);
    assert.match(message, /asked TypeSafe \(Jev\)/);
    assert.match(message, /left unchanged on purpose/);
    assert.match(message, /compact or hint cannot come from a bad answer/);
    assert.match(message, /can be temporary/);
    assert.match(message, /try again later/);
    assert.match(message, /unless it keeps repeating/);
  }
  for (const kind of ["authentication", "input"] as const) {
    const message = judgeErrorMessage(kind);
    assert.match(message, /asked TypeSafe \(Jev\)/);
    assert.match(message, /left unchanged on purpose/);
    assert.doesNotMatch(message, /can be temporary/);
    assert.doesNotMatch(message, /try again later/);
    assert.match(message, /not a temporary glitch/);
  }
  assert.match(judgeErrorMessage("authentication"), /TypeSafe key configuration/);
  assert.match(judgeErrorMessage("input"), /size limit/);
  assert.match(JUDGE_UNAVAILABLE_MESSAGE, /can be temporary/);
});

test("cwd .env supplies TYPESAFE_API_KEY when process env is empty and is ignored when env is set", (t) => {
  const dir = temp(t);
  writeFileSync(
    join(dir, ".env"),
    "# TYPESAFE_API_KEY=commented\n\nOTHER=nope\nTYPESAFE_API_KEY=from-dotenv\nTYPESAFE_API_KEY=from-dotenv-last\n",
  );
  assert.equal(resolveTypesafeApiKey({ TYPESAFE_API_KEY: "" }, dir), "from-dotenv-last");
  assert.equal(resolveTypesafeApiKey({}, dir), "from-dotenv-last");
  assert.equal(resolveTypesafeApiKey({ TYPESAFE_API_KEY: "from-env" }, dir), "from-env");
  assert.equal(resolveTypesafeApiKey({ TYPESAFE_API_KEY: "   " }, dir), "from-dotenv-last");
  assert.equal(resolveTypesafeApiKey({}, temp(t)), undefined);
  assert.equal(parseDotenvKey("TYPESAFE_API_KEY=only\n", "TYPESAFE_API_KEY"), "only");
});

test("cwd .env accepts export, declare -x, and one matching quote layer", (t) => {
  const dir = temp(t);
  writeFileSync(join(dir, ".env"), 'declare -x TYPESAFE_API_KEY="from-declare"\n');
  assert.equal(resolveTypesafeApiKey({}, dir), "from-declare");
  writeFileSync(join(dir, ".env"), "export TYPESAFE_API_KEY='from-export'\n");
  assert.equal(resolveTypesafeApiKey({}, dir), "from-export");
  writeFileSync(join(dir, ".env"), "export TYPESAFE_API_KEY=from-export-plain\n");
  assert.equal(resolveTypesafeApiKey({ TYPESAFE_API_KEY: "from-env" }, dir), "from-env");
  assert.equal(
    parseDotenvKey('TYPESAFE_API_KEY="from-double"\n', "TYPESAFE_API_KEY"),
    "from-double",
  );
  assert.equal(
    parseDotenvKey("TYPESAFE_API_KEY='from-single'\n", "TYPESAFE_API_KEY"),
    "from-single",
  );
  assert.equal(
    parseDotenvKey('export TYPESAFE_API_KEY="from-export-quoted"\n', "TYPESAFE_API_KEY"),
    "from-export-quoted",
  );
});

test("the request deadline aborts work instead of delaying the next turn", async () => {
  let aborted = false;
  const transport = (async (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify(apiResponse()))), 5000);
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    })) as typeof fetch;
  await assert.rejects(
    judge({}, "fixture", new AbortController().signal, transport, 20),
    (error: unknown) => error instanceof JudgeError && error.kind === "timeout",
  );
  assert.equal(aborted, true);
});
