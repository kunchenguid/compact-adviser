// Reading Codex's rollout transcript, which its own documentation calls unstable: the mapping
// has to survive records this version has never seen and never throw on the turn's hot path.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import {
  MAX_ROLLOUT_BYTES,
  mapRecords,
  patchPaths,
  readRollout,
  usageFraction,
} from "../src/rollout.ts";
import { SUMMARY_PREFIX } from "../src/snapshot.ts";
import {
  assistantMessage,
  makeLab,
  sessionMeta,
  tokenCount,
  toolCall,
  toolOutput,
  userMessage,
  writeRollout,
} from "./support.ts";

test("maps messages, tool calls, and their results into the snapshot's shape", () => {
  const rollout = mapRecords([
    sessionMeta(),
    userMessage("Ship the fix, then report."),
    toolCall("apply_patch", "*** Begin Patch\n*** Add File: src/a.ts\n*** End Patch"),
    toolOutput("Applied."),
    assistantMessage("Shipped."),
  ]);
  assert.equal(rollout.originator, "codex-tui");
  assert.deepEqual(
    rollout.messages.map((m) => [m.role, m.text, m.toolUses.map((use) => use.tool)]),
    [
      ["user", "Ship the fix, then report.", []],
      ["assistant", "", ["apply_patch"]],
      ["assistant", "Shipped.", []],
    ],
  );
  const [use] = rollout.messages[1]?.toolUses ?? [];
  assert.deepEqual(use?.paths, ["src/a.ts"]);
  assert.equal(use?.text, "Applied.");
  assert.equal(use?.isError, undefined);
});

test("drops the context Codex injects as user records, keeping the person's own asks", () => {
  const rollout = mapRecords([
    userMessage("<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>"),
    userMessage("<user_instructions>be terse</user_instructions>"),
    userMessage("Real ask."),
    {
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ text: "skills" }] },
    },
  ]);
  assert.deepEqual(
    rollout.messages.map((m) => m.text),
    ["Real ask."],
  );
});

test("a compaction record becomes the prior summary the snapshot already reads", () => {
  const rollout = mapRecords([
    {
      type: "response_item",
      payload: { type: "compaction", content: [{ type: "input_text", text: "earlier work" }] },
    },
  ]);
  assert.equal(rollout.messages[0]?.role, "user");
  assert.ok(rollout.messages[0]?.text.startsWith(SUMMARY_PREFIX));
  assert.ok(rollout.messages[0]?.text.includes("earlier work"));
});

test("a failed tool result is marked as an error", () => {
  const rollout = mapRecords([
    toolCall("shell", "{}"),
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_1",
        output: { success: false, content: "exit 1" },
      },
    },
  ]);
  assert.equal(rollout.messages[0]?.toolUses[0]?.isError, true);
  assert.equal(rollout.messages[0]?.toolUses[0]?.text, "exit 1");
});

test("usage comes from the last token_count record and degrades to NaN", () => {
  const rollout = mapRecords([tokenCount(10), tokenCount(95941, 258400)]);
  assert.equal(rollout.tokens, 95941);
  assert.equal(rollout.window, 258400);
  assert.equal(usageFraction(rollout), 95941 / 258400);
  assert.ok(Number.isNaN(usageFraction({ tokens: 5, window: 0 })));
  assert.ok(Number.isNaN(usageFraction({ tokens: undefined, window: 1000 })));
  assert.ok(Number.isNaN(usageFraction(mapRecords([]))));
});

test("unknown, malformed, and unparsable records are skipped, not fatal", () => {
  const rollout = mapRecords([
    null,
    "nonsense",
    { type: "response_item" },
    { type: "brand_new_record_kind", payload: { type: "whatever" } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: "?" } } },
    assistantMessage("still read"),
  ]);
  assert.deepEqual(
    rollout.messages.map((m) => m.text),
    ["still read"],
  );
  assert.equal(rollout.tokens, undefined);
});

test("patchPaths names what an apply_patch body writes, and not what it deletes", () => {
  const paths = patchPaths(
    [
      "*** Begin Patch",
      "*** Add File: a.ts",
      "*** Update File: src/b.ts",
      "*** Delete File: gone.ts",
      "*** Move to: src/c.ts",
      "*** End Patch",
    ].join("\n"),
  );
  assert.deepEqual(paths, ["a.ts", "src/b.ts", "src/c.ts"]);
  assert.deepEqual(patchPaths("not a patch"), []);
});

test("readRollout reads a file, and answers empty for one it cannot read", () => {
  const lab = makeLab();
  try {
    writeRollout(lab.transcript, [sessionMeta(), assistantMessage("done"), tokenCount(1234)]);
    const rollout = readRollout(lab.transcript);
    assert.equal(rollout.tokens, 1234);
    assert.equal(rollout.messages.length, 1);

    const missing = readRollout(`${lab.transcript}.missing`);
    assert.deepEqual(missing.messages, []);
    assert.equal(missing.tokens, undefined);
  } finally {
    lab.cleanup();
  }
});

test("a rollout past the read window keeps its header and its newest records", () => {
  const lab = makeLab();
  try {
    const filler = JSON.stringify(assistantMessage("x".repeat(64 * 1024)));
    const lines = [
      JSON.stringify(sessionMeta()),
      JSON.stringify(userMessage("oldest, beyond the window")),
      ...Array.from({ length: Math.ceil(MAX_ROLLOUT_BYTES / filler.length) + 2 }, () => filler),
      JSON.stringify(assistantMessage("newest")),
      JSON.stringify(tokenCount(4242)),
    ];
    writeFileSync(lab.transcript, `${lines.join("\n")}\n`);

    const rollout = readRollout(lab.transcript);
    assert.equal(rollout.originator, "codex-tui", "the session header is read separately");
    assert.equal(rollout.tokens, 4242);
    assert.equal(rollout.messages.at(-1)?.text, "newest");
    assert.ok(!rollout.messages.some((m) => m.text.includes("oldest")));
  } finally {
    lab.cleanup();
  }
});
