import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import test from "node:test";
import {
  JUDGE_UNAVAILABLE_MESSAGE,
  JudgeError,
  parseJudgment,
  requestBody,
  score,
} from "../src/judge.ts";
import { requestLogPath } from "../src/log.ts";
import { restoreState } from "../src/state.ts";
import { apiResponse, assistant, flush, harness, success, toolResult } from "./helpers.ts";

test("threshold is a constant 40k and requests only run at settlement", async (t) => {
  const h = harness(t);
  h.enable();
  h.tokens = 39999;
  await h.fire("turn_end");
  await h.fire("agent_end");
  await h.fire("agent_settled");
  assert.equal(h.calls, 0);
  h.next();
  h.tokens = 40000;
  await h.fire("turn_end");
  assert.equal(h.calls, 0);
  await h.fire("agent_settled");
  assert.equal(h.calls, 1);
  assert.equal(h.compactions.length, 0);
  assert.ok(h.notifications.some((x) => x.endsWith("Run /compact to save tokens.")));
  await h.fire("agent_settled");
  assert.equal(h.calls, 1);
});

test("the hint floor slides with context usage: a finished coordinating unit hints only once the window is fuller", async (t) => {
  // finished but coordinating scores 0.5: below the 0.87 floor at 17 % of the
  // 272k window, at the 0.50 floor from 90 % on. Same judgment, different window fill.
  const h = harness(t, async () => parseJudgment(apiResponse(1, 0)));
  h.enable();
  h.tokens = 45000;
  await h.fire("agent_settled");
  assert.equal(h.calls, 1);
  assert.ok(!h.notifications.some((x) => x.endsWith("Run /compact to save tokens.")));
  h.next("and now the window is nearly full");
  h.tokens = 245000;
  await h.fire("agent_settled");
  assert.equal(h.calls, 2);
  assert.ok(h.notifications.some((x) => x.endsWith("Run /compact to save tokens.")));
});

test("unknown usage, missing key, off, busy, pending, error and non-TUI never call Jev", async (t) => {
  for (const scenario of [
    "unknown",
    "key",
    "off",
    "busy",
    "pending",
    "error",
    "aborted",
    "length",
    "toolUse",
    "print",
    "rpc",
    "json",
    "old-version",
  ]) {
    const h = harness(t);
    h.enable();
    if (scenario === "unknown") h.tokens = null;
    if (scenario === "key") h.install("0.82.0", "");
    if (scenario === "off") h.store.update({ mode: "off" });
    if (scenario === "busy") h.idle = false;
    if (scenario === "pending") h.pending = true;
    if (["error", "aborted", "length", "toolUse"].includes(scenario))
      h.next("Incomplete", scenario as "error");
    if (["print", "rpc", "json"].includes(scenario)) h.ctx.mode = scenario as "print";
    if (scenario === "old-version") h.install("0.81.0");
    await h.fire("agent_settled");
    assert.equal(h.calls, 0, scenario);
  }
});

test("persistent settings menu prefills, validates, saves, cancels and resets only minimum", async (t) => {
  const h = harness(t);
  h.enable("auto");
  h.selects.push("Minimum context: 40,000 tokens", "Close");
  h.inputs.push("-1", "60000");
  await h.command("");
  assert.deepEqual(h.inputDefaults, ["40000", "40000"]);
  assert.equal(h.store.read().minContextTokens, 60000);
  assert.equal(h.store.read().mode, "auto");
  assert.ok(h.notifications.includes("Minimum context saved: 60,000 tokens (all sessions)."));
  h.install();
  await h.fire("session_start");
  assert.ok(h.statuses.every((s) => s === undefined));
  h.selects.push("Minimum context: 60,000 tokens", "Close");
  h.inputs.push(undefined);
  await h.command("");
  assert.equal(h.store.read().minContextTokens, 60000);
  await h.command("threshold default");
  assert.equal(h.store.read().minContextTokens, 40000);
  assert.equal(h.store.read().mode, "auto");
  await h.command("threshold 0");
  assert.equal(h.store.read().minContextTokens, 40000);
  await h.command("threshold 999999");
  assert.equal(h.store.read().minContextTokens, 999999);
  assert.ok(h.notifications.some((n) => n.includes("at or above")));
  await h.command("status");
  assert.ok(h.notifications.at(-1)?.includes("Key: env"));
  assert.ok(!h.notifications.at(-1)?.includes("test-key"));
  assert.ok(!h.notifications.at(-1)?.includes("Sharing:"));
});

test("settings menu saves and clears a TypeSafe key without printing it", async (t) => {
  const previous = process.env.TYPESAFE_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  });
  delete process.env.TYPESAFE_API_KEY;
  const h = harness(t);
  h.install("0.82.0", false);
  const secret = "tsk-menu-fixture-not-for-display";
  h.selects.push("TypeSafe API key: not saved", "Set key", "Close");
  h.inputs.push(secret);
  await h.command("");
  assert.equal(h.store.read().typesafeApiKey, secret);
  assert.equal(statSync(h.store.path).mode & 0o777, 0o600);
  assert.ok(
    h.notifications.includes(
      "TypeSafe API key saved (all sessions). Status shows the source, never the value.",
    ),
  );
  assert.ok(h.notifications.every((n) => !n.includes(secret)));
  assert.ok(
    h.customRenders.some((lines) =>
      lines.some((line) => line.includes("*") && !line.includes(secret)),
    ),
  );
  await h.command("status");
  assert.ok(h.notifications.at(-1)?.includes("Key: saved"));
  assert.ok(!h.notifications.at(-1)?.includes(secret));
  h.selects.push("TypeSafe API key: saved", "Clear saved key", "Close");
  await h.command("");
  assert.equal(h.store.read().typesafeApiKey, undefined);
  assert.ok(h.notifications.every((n) => !n.includes(secret)));
  await h.command("status");
  assert.ok(h.notifications.at(-1)?.includes("Key: missing"));
  assert.ok(!h.notifications.at(-1)?.includes(secret));
});

test("auto requires explicit confirmation, persist, and never compact on selection", async (t) => {
  const h = harness(t);
  h.confirms.push(false);
  await h.command("auto");
  assert.equal(h.store.read().mode, "hint");
  h.confirms.push(true);
  await h.command("auto");
  assert.equal(h.store.read().mode, "auto");
  assert.equal(h.compactions.length, 0);
  await h.command("sharing on");
  assert.ok(
    h.notifications
      .at(-1)
      ?.includes(
        "Use /compact-adviser, auto, hint, off, status, threshold <tokens|default>, snooze or dismiss.",
      ),
  );
  await h.command("hint");
  assert.equal(h.store.read().mode, "hint");
  await h.command("off");
  assert.equal(h.store.read().mode, "off");
});

test("legacy sharingConsent in saved settings is ignored; install is consent", async (t) => {
  const h = harness(t);
  writeFileSync(
    h.store.path,
    `${JSON.stringify({
      version: 1,
      mode: "hint",
      minContextTokens: 40000,
      sharingConsent: false,
      autoAcknowledged: false,
    })}\n`,
  );
  await h.fire("agent_settled");
  assert.equal(h.calls, 1);
  h.store.update({ mode: "hint" });
  assert.equal("sharingConsent" in JSON.parse(readFileSync(h.store.path, "utf8")), false);
});

test("auto compacts at a qualifying checkpoint, errors back off", async (t) => {
  const h = harness(t);
  h.enable("auto");
  await h.fire("agent_settled");
  assert.equal(h.compactions.length, 1);
  h.compactions[0].onError?.(new Error("fixture cancel"));
  h.next();
  await h.fire("agent_settled");
  assert.equal(h.calls, 1);
  h.clock = 200000;
  h.next("Later checkpoint");
  await h.fire("agent_settled");
  assert.equal(h.calls, 2);
});

test("auto still compacts when recent content exceeds coverage", async (t) => {
  const h = harness(t);
  h.enable("auto");
  h.next("Critical unsaved result ".repeat(2000));
  await h.fire("agent_settled");
  assert.equal(h.calls, 1);
  assert.equal(h.compactions.length, 1);
});

test("late answers are discarded on all native invalidation events", async (t) => {
  for (const event of [
    "before_agent_start",
    "input",
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
    "session_tree",
    "model_select",
    "session_shutdown",
    "session_before_compact",
  ]) {
    let answer: ((j: ReturnType<typeof success>) => void) | undefined;
    const h = harness(
      t,
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    h.enable("auto");
    await h.fire("agent_settled");
    assert.equal(h.calls, 1);
    await h.fire(event);
    assert.equal(h.signals[0].aborted, true, event);
    answer?.(success());
    await flush();
    assert.equal(h.compactions.length, 0, event);
  }
});

test("a cross-session disable or new pending message wins over a favorable in-flight answer", async (t) => {
  for (const kind of ["config", "pending", "leaf"]) {
    let answer: ((j: ReturnType<typeof success>) => void) | undefined;
    const h = harness(
      t,
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    h.enable("auto");
    await h.fire("agent_settled");
    if (kind === "config") h.store.update({ mode: "off" });
    else if (kind === "pending") h.pending = true;
    else h.next("Newer context");
    answer?.(success());
    await flush();
    assert.equal(h.compactions.length, 0, kind);
  }
});

test("compaction callback cannot touch an invalidated session", async (t) => {
  const h = harness(t);
  h.enable("auto");
  await h.fire("agent_settled");
  assert.equal(h.compactions.length, 1);
  await h.fire("session_shutdown");
  h.ctx.sessionManager = new Proxy(h.sm, {
    get() {
      throw new Error("stale session");
    },
  });
  assert.doesNotThrow(() => h.compactions[0].onError?.(new Error("late error")));
});

test("unknown post-compaction usage and 20k growth plus three exchanges survive reload", async (t) => {
  const h = harness(t);
  h.enable();
  const kept = h.sm.getLeafId();
  assert.ok(kept);
  const compact = h.sm.appendCompaction("Durable summary", kept, 45000);
  await h.fire("session_compact", { compactionEntry: h.sm.getEntry(compact) });
  h.tokens = null;
  await h.fire("agent_settled");
  assert.equal(h.calls, 0);
  // A fresh large recent history creates useful reducible context again.
  h.next("Older continued exploration ".repeat(5000));
  for (let i = 0; i < 7; i++) h.next(`step ${i}`);
  h.tokens = 45000;
  await h.fire("agent_settled");
  assert.equal(h.calls, 0);
  h.install();
  h.next("Second exchange");
  h.tokens = 65000;
  await h.fire("agent_settled");
  assert.equal(h.calls, 0);
  h.next("Third exchange completed and saved");
  await h.fire("agent_settled");
  assert.equal(h.calls, 1);
});

test("hint deduplication, snooze and dismissal survive reload", async (t) => {
  const h = harness(t);
  h.enable();
  await h.fire("agent_settled");
  assert.equal(h.calls, 1);
  await h.command("snooze");
  h.install();
  for (let i = 0; i < 3; i++) {
    h.next(`New checkpoint ${i}`);
    await h.fire("agent_settled");
  }
  assert.equal(h.calls, 1);
  h.next("New completed checkpoint");
  await h.fire("agent_settled");
  assert.equal(h.calls, 2);
  await h.command("dismiss");
  assert.equal(h.widgets.at(-1), undefined);
});

test("malformed settings and transient judge failures leave context intact", async (t) => {
  const h = harness(t, async () => {
    throw new Error("network failure with secret not for display");
  });
  h.enable();
  await h.fire("agent_settled");
  h.next();
  await h.fire("agent_settled");
  assert.equal(h.calls, 1);
  assert.equal(h.compactions.length, 0);
  assert.ok(h.notifications.every((n) => !n.includes("secret not for display")));
  assert.ok(h.notifications.includes(JUDGE_UNAVAILABLE_MESSAGE));
  assert.ok(restoreState(h.sm.getBranch()).retryAfter > 100000);
  writeFileSync(h.store.path, "broken");
  h.next("After malformed config");
  await h.fire("agent_settled");
  assert.equal(h.calls, 1);
});

test("automatic compaction respects the actual native retention setting without blocking manual compaction", async (t) => {
  const h = harness(t);
  h.enable("auto");
  await h.fire("agent_settled");
  const result = await h.fire("session_before_compact", {
    preparation: { settings: { keepRecentTokens: 1000 } },
  });
  assert.ok(result.some((value) => (value as { cancel?: boolean })?.cancel));
  h.compactions[0].onError?.(new Error("Compaction cancelled"));
  const manual = await h.fire("session_before_compact", {
    preparation: { settings: { keepRecentTokens: 1000 } },
  });
  assert.ok(manual.every((value) => value === undefined));
});

test("draft input and an absent active model suppress judgment", async (t) => {
  const h = harness(t);
  h.enable("auto");
  h.ctx.ui.getEditorText = () => "An unsent new instruction";
  await h.fire("agent_settled");
  assert.equal(h.calls, 0);
  h.ctx.ui.getEditorText = () => "";
  h.ctx.model = undefined;
  h.next();
  await h.fire("agent_settled");
  assert.equal(h.calls, 0);
});

test("TypeSafe request logging is off by default and writes a redacted body without the key", async (t) => {
  const off = harness(t);
  off.enable();
  await off.fire("agent_settled");
  assert.equal(off.calls, 1);
  assert.equal(existsSync(requestLogPath(off.dir)), false);
  const on = harness(t);
  on.enable();
  on.selects.push("Log TypeSafe requests: off", "On", "Close");
  await on.command("");
  assert.equal(on.store.read().logRequests, true);
  assert.ok(on.notifications.at(-1)?.includes(requestLogPath(on.dir)));
  await on.fire("agent_settled");
  assert.equal(on.calls, 1);
  const logged = readFileSync(requestLogPath(on.dir), "utf8");
  const lines = logged
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, "request");
  assert.equal(lines[0].body.model, "jev-latest");
  assert.equal(lines[1].kind, "response");
  assert.equal(lines[1].id, lines[0].id);
  assert.equal(lines[1].answers.done.choice, "finished");
  assert.equal(typeof lines[1].answers.done.probabilities.finished, "number");
  assert.equal(typeof lines[1].answers.shape.probabilities.hands_on, "number");
  assert.equal(lines[1].score, score(success()));
  assert.equal(typeof lines[1].usage, "number");
  assert.equal(typeof lines[1].floor, "number");
  assert.equal(lines[1].qualifies, true);
  assert.ok(logged.includes("Finish and save the report"));
  assert.ok(!logged.includes("test-key"));
});

test("a silent no-qualify turn still logs the Jev response", async (t) => {
  const judgment = parseJudgment(apiResponse(0.99, 0.01));
  const h = harness(t, async () => judgment);
  h.enable();
  h.store.update({ logRequests: true });
  h.tokens = 45000;
  await h.fire("agent_settled");
  assert.equal(h.calls, 1);
  assert.ok(!h.notifications.some((x) => x.endsWith("Run /compact to save tokens.")));
  const lines = readFileSync(requestLogPath(h.dir), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines[1].kind, "response");
  assert.equal(lines[1].qualifies, false);
  assert.equal(lines[1].score, score(judgment));
  assert.ok(!JSON.stringify(lines).includes("test-key"));
});

test("a judgment failure logs the error kind without the key", async (t) => {
  const secret = "tsk-error-must-not-leave";
  const h = harness(t, async () => {
    throw new Error(`TypeSafe exploded ${secret}`);
  });
  h.install("0.82.0", secret);
  h.enable();
  h.store.update({ logRequests: true });
  await h.fire("agent_settled");
  assert.equal(h.calls, 1);
  const lines = readFileSync(requestLogPath(h.dir), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines[0].kind, "request");
  assert.equal(lines[1].kind, "error");
  assert.equal(lines[1].id, lines[0].id);
  assert.deepEqual(lines[1].error, { kind: "unavailable" });
  const logged = readFileSync(requestLogPath(h.dir), "utf8");
  assert.ok(!logged.includes(secret));
});

test("a JudgeError logs its kind and not its message", async (t) => {
  const h = harness(t, async () => {
    throw new JudgeError("timeout");
  });
  h.enable();
  h.store.update({ logRequests: true });
  await h.fire("agent_settled");
  const lines = readFileSync(requestLogPath(h.dir), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(lines[1].error, { kind: "timeout" });
  assert.equal(JSON.stringify(lines[1]).includes("timed out"), false);
});

test("a saved key in a compact-adviser.json read is absent from the request body and log", async (t) => {
  const previous = process.env.TYPESAFE_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  });
  delete process.env.TYPESAFE_API_KEY;
  const h = harness(t);
  h.install("0.82.0", false);
  const secret = "tsk-saved-key-must-not-leave";
  h.store.update({ typesafeApiKey: secret, logRequests: true });
  h.enable();
  const artifact = `notes-${secret}.md`;
  writeFileSync(`${h.dir}/${artifact}`, "ok");
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
        arguments: { path: h.store.path },
      },
    ],
    stopReason: "toolUse",
  });
  h.sm.appendMessage(toolResult(readFileSync(h.store.path, "utf8"), "read", "read-settings"));
  h.next();
  await h.fire("agent_settled");
  assert.equal(h.calls, 1);
  const body = requestBody(h.payloads[0]);
  const logged = readFileSync(requestLogPath(h.dir), "utf8");
  assert.ok(!body.includes(secret));
  assert.ok(!logged.includes(secret));
  assert.ok(body.includes("hint"));
  assert.ok(logged.includes("jev-latest"));
});
