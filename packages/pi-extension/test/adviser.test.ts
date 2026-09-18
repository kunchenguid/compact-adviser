import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { JUDGE_UNAVAILABLE_MESSAGE } from "../src/judge.ts";
import { requestLogPath } from "../src/log.ts";
import { restoreState } from "../src/state.ts";
import { flush, harness, success } from "./helpers.ts";

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
  assert.ok(h.notifications.at(-1)?.includes("Key: present"));
  assert.ok(!h.notifications.at(-1)?.includes("test-key"));
  assert.ok(!h.notifications.at(-1)?.includes("Sharing:"));
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
  assert.ok(logged.includes("jev-latest"));
  assert.ok(logged.includes("Finish and save the report"));
  assert.ok(!logged.includes("test-key"));
});
