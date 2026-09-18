import assert from "node:assert/strict";
import { readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { lockSync } from "proper-lockfile";
import { ConfigStore, DEFAULT_CONFIG, parseMinimum, parseSavedApiKey } from "../src/config.ts";
import { RECENT_TAIL_MESSAGES, snapshot } from "../src/context.ts";
import { parseDotenvKey, resolveTypesafeApiKey } from "../src/env.ts";
import {
  ENDPOINT,
  FLOOR_MAX,
  FLOOR_MIN,
  floorFor,
  JUDGE_UNAVAILABLE_MESSAGE,
  JudgeError,
  judge,
  judgeErrorMessage,
  MAX_REQUEST_BYTES,
  parseJudgment,
  qualifies,
  requestBody,
  score,
  USAGE_LOOSE_AT,
  USAGE_STRICT_UNTIL,
} from "../src/judge.ts";
import {
  appendRequestLog,
  errorLogLine,
  loggedJudgeErrorKind,
  requestLogId,
  requestLogLine,
  requestLogPath,
  responseLogLine,
} from "../src/log.ts";
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
  a.update({ typesafeApiKey: "tsk-store-fixture" });
  assert.equal(a.read().typesafeApiKey, "tsk-store-fixture");
  assert.equal(statSync(a.path).mode & 0o777, 0o600);
  a.update({ typesafeApiKey: "" });
  assert.equal("typesafeApiKey" in JSON.parse(readFileSync(a.path, "utf8")), false);
});

test("minimum parsing rejects ambiguous, nonpositive or unsafe values", () => {
  assert.equal(parseMinimum(" 40000 "), 40000);
  for (const value of ["", "0", "-1", "1.5", "40k", "4e4", "NaN", "Infinity", "9007199254740992"])
    assert.throws(() => parseMinimum(value), value);
});

test("saved API key parsing trims, rejects empty, overlong, and control characters", () => {
  assert.equal(parseSavedApiKey("  tsk-ok  "), "tsk-ok");
  assert.throws(() => parseSavedApiKey("   "));
  assert.throws(() => parseSavedApiKey("x".repeat(1025)));
  assert.throws(() => parseSavedApiKey("tsk\nok"));
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

test("a compact-adviser.json read keeps mode diagnostics and drops the saved key from the body", (t) => {
  const h = harness(t);
  const secret = "tsk-saved-key-must-not-leave";
  const artifact = `notes-${secret}.md`;
  writeFileSync(join(h.dir, artifact), "ok");
  h.sm.appendMessage({
    ...assistant(""),
    content: [
      {
        type: "toolCall",
        id: "write-notes",
        name: "write",
        arguments: { path: artifact },
      },
    ],
    stopReason: "toolUse",
  });
  h.sm.appendMessage(toolResult("ok", "write", "write-notes"));
  h.sm.appendMessage({
    ...assistant(""),
    content: [
      {
        type: "toolCall",
        id: "read-settings",
        name: "read",
        arguments: { path: join(h.dir, "compact-adviser.json") },
      },
    ],
    stopReason: "toolUse",
  });
  h.sm.appendMessage(
    toolResult(
      `${JSON.stringify({
        version: 1,
        mode: "hint",
        minContextTokens: 40000,
        logRequests: true,
        typesafeApiKey: secret,
      })}\n`,
      "read",
      "read-settings",
    ),
  );
  const view = snapshot(h.ctx, [secret]);
  const body = requestBody(view.state);
  assert.ok(!body.includes(secret));
  assert.ok(body.includes("hint"));
  assert.ok(body.includes("40000"));
  assert.ok(body.includes("[REDACTED]"));
  assert.equal(view.state.coverage.redacted, true);
  assert.deepEqual(view.state.savedArtifacts, ["notes-[REDACTED].md"]);
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

test("two typed factors compose into one score; the floor slides with usage", () => {
  const valid = parseJudgment(apiResponse());
  assert.equal(FLOOR_MAX, 0.9);
  assert.equal(FLOOR_MIN, 0.5);
  assert.equal(USAGE_STRICT_UNTIL, 0.1);
  assert.equal(USAGE_LOOSE_AT, 0.9);
  assert.ok(qualifies(valid, 0.2));
  // finished is the gate, hands-on adds up to half again
  assert.ok(Math.abs(score(parseJudgment(apiResponse(1, 1))) - 1) < 1e-9);
  assert.ok(Math.abs(score(parseJudgment(apiResponse(1, 0))) - 0.5) < 1e-9);
  assert.ok(Math.abs(score(parseJudgment(apiResponse(0, 1))) - 0) < 1e-9);
  assert.ok(Math.abs(score(parseJudgment(apiResponse(0.8, 0.5))) - 0.6) < 1e-9);
  // the schedule: 0.90 through 10 %, linear ramp to 0.50 at 90 %
  assert.equal(floorFor(0), 0.9);
  assert.equal(floorFor(0.1), 0.9);
  assert.equal(floorFor(0.5), 0.7);
  assert.equal(floorFor(0.9), 0.5);
  assert.equal(floorFor(1), 0.5);
  assert.equal(floorFor(Number.NaN), 0.9);
  assert.equal(floorFor(-1), 0.9);
  for (let u = 0; u < 1; u += 0.05) assert.ok(floorFor(u) >= floorFor(u + 0.05));
  // a finished coordinating unit (score 0.5) hints only once the window is 90 % full
  const coordinating = parseJudgment(apiResponse(1, 0));
  assert.ok(!qualifies(coordinating, 0.3));
  assert.ok(!qualifies(coordinating, 0.89));
  assert.ok(qualifies(coordinating, 0.9));
  // a confident hands-on completion hints at any usage; unfinished work never does
  assert.ok(qualifies(parseJudgment(apiResponse(0.95, 0.9)), 0));
  assert.ok(!qualifies(parseJudgment(apiResponse(0.2, 1)), 1));
  const bad = apiResponse();
  bad.answers.done.probabilities.finished = 0.6;
  assert.throws(() => parseJudgment(bad));
  const missingShape = apiResponse() as {
    answers: Partial<ReturnType<typeof apiResponse>["answers"]>;
  };
  delete missingShape.answers.shape;
  assert.throws(() => parseJudgment(missingShape));
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
  assert.deepEqual(Object.keys(body.questions), ["done", "shape"]);
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
  assert.deepEqual(resolveTypesafeApiKey({ TYPESAFE_API_KEY: "" }, dir), {
    value: "from-dotenv-last",
    source: ".env",
  });
  assert.deepEqual(resolveTypesafeApiKey({}, dir), { value: "from-dotenv-last", source: ".env" });
  assert.deepEqual(resolveTypesafeApiKey({ TYPESAFE_API_KEY: "from-env" }, dir), {
    value: "from-env",
    source: "env",
  });
  assert.deepEqual(resolveTypesafeApiKey({ TYPESAFE_API_KEY: "   " }, dir), {
    value: "from-dotenv-last",
    source: ".env",
  });
  assert.deepEqual(resolveTypesafeApiKey({}, temp(t)), { value: undefined, source: "missing" });
  assert.equal(parseDotenvKey("TYPESAFE_API_KEY=only\n", "TYPESAFE_API_KEY"), "only");
});

test("cwd .env accepts export, declare -x, and one matching quote layer", (t) => {
  const dir = temp(t);
  writeFileSync(join(dir, ".env"), 'declare -x TYPESAFE_API_KEY="from-declare"\n');
  assert.deepEqual(resolveTypesafeApiKey({}, dir), { value: "from-declare", source: ".env" });
  writeFileSync(join(dir, ".env"), "export TYPESAFE_API_KEY='from-export'\n");
  assert.deepEqual(resolveTypesafeApiKey({}, dir), { value: "from-export", source: ".env" });
  writeFileSync(join(dir, ".env"), "export TYPESAFE_API_KEY=from-export-plain\n");
  assert.deepEqual(resolveTypesafeApiKey({ TYPESAFE_API_KEY: "from-env" }, dir), {
    value: "from-env",
    source: "env",
  });
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

test("a saved menu key sits between process env and cwd .env", (t) => {
  const dir = temp(t);
  writeFileSync(join(dir, ".env"), "TYPESAFE_API_KEY=from-dotenv\n");
  assert.deepEqual(resolveTypesafeApiKey({}, dir, "from-saved"), {
    value: "from-saved",
    source: "saved",
  });
  assert.deepEqual(resolveTypesafeApiKey({ TYPESAFE_API_KEY: "from-env" }, dir, "from-saved"), {
    value: "from-env",
    source: "env",
  });
  assert.deepEqual(resolveTypesafeApiKey({ TYPESAFE_API_KEY: "   " }, dir, "from-saved"), {
    value: "from-saved",
    source: "saved",
  });
  assert.deepEqual(resolveTypesafeApiKey({}, dir, "   "), {
    value: "from-dotenv",
    source: ".env",
  });
  assert.deepEqual(resolveTypesafeApiKey({}, temp(t), undefined), {
    value: undefined,
    source: "missing",
  });
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

test("TypeSafe log lines record the gate decision without secrets", () => {
  const secret = "tsk-fixture-must-not-leave";
  const body = requestBody({ note: "ok" });
  const judgment = parseJudgment(apiResponse(0.93, 0.97));
  const at = "2026-09-18T00:00:00.000Z";
  const usage = 0.2;
  const request = JSON.parse(requestLogLine(body, at));
  const response = JSON.parse(responseLogLine(body, judgment, usage, at));
  const failure = JSON.parse(errorLogLine("timeout", body, at));
  assert.equal(request.kind, "request");
  assert.equal(request.id, requestLogId(body));
  assert.equal(request.at, at);
  assert.equal(request.body.model, "jev-latest");
  assert.equal(response.kind, "response");
  assert.equal(response.id, request.id);
  assert.equal(response.answers.done.choice, "finished");
  assert.deepEqual(response.answers.done.probabilities, judgment.done.probabilities);
  assert.equal(response.answers.shape.choice, "hands_on");
  assert.deepEqual(response.answers.shape.probabilities, judgment.shape.probabilities);
  assert.equal(response.score, score(judgment));
  assert.equal(response.usage, usage);
  assert.equal(response.floor, floorFor(usage));
  assert.equal(response.qualifies, qualifies(judgment, usage));
  assert.equal(failure.kind, "error");
  assert.equal(failure.id, request.id);
  assert.deepEqual(failure.error, { kind: "timeout" });
  const unknownUsage = JSON.parse(responseLogLine(body, judgment, Number.NaN, at));
  assert.equal(unknownUsage.usage, null);
  assert.equal(unknownUsage.floor, FLOOR_MAX);
  assert.equal(unknownUsage.qualifies, qualifies(judgment, Number.NaN));
  const auth = new JudgeError("authentication");
  assert.equal(loggedJudgeErrorKind(auth), "authentication");
  assert.equal(loggedJudgeErrorKind(new Error(`boom ${secret}`)), "unavailable");
  for (const line of [
    requestLogLine(body, at),
    responseLogLine(body, judgment, usage, at),
    errorLogLine(loggedJudgeErrorKind(auth), body, at),
    errorLogLine(loggedJudgeErrorKind(new Error(`boom ${secret}`)), body, at),
  ]) {
    assert.equal(line.includes(secret), false);
    assert.equal(line.includes("Authorization"), false);
    assert.equal(line.includes("Bearer"), false);
    assert.equal(line.includes(auth.message), false);
  }
});

test("TypeSafe log append keeps prior lines", (t) => {
  const dir = temp(t);
  const prior = requestBody({ note: "prior-session" });
  const body = requestBody({ note: "ok" });
  appendRequestLog(dir, prior);
  appendRequestLog(dir, body);
  const text = readFileSync(requestLogPath(dir), "utf8");
  const lines = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].body.state.note, "prior-session");
  assert.equal(lines[1].id, requestLogId(body));
  assert.notEqual(lines[0].id, lines[1].id);
});
