// The Grok-specific glue, exercised directly: the transcript reader against the record shapes
// Grok actually writes, the status-row composition, the verdict's own expiry rules, and the
// settings this host owns. The shared judge and cooldown modules are covered by the other
// packages' suites and by packages/pi-extension/test/lockstep.test.ts.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  parseBudget,
  parseMode,
  parseSettings,
  readSettings,
  SettingsError,
} from "../lib/config.ts";
import { snapshot } from "../lib/snapshot.ts";
import { HINT, itemsLine, parsePayload, statusLine } from "../lib/statusline.ts";
import { type Verdict, verdictApplies } from "../lib/store.ts";
import { parseChatHistory, userText } from "../lib/transcript.ts";
import { readPayloadUsage, readSignalsUsage, usageFraction } from "../lib/usage.ts";

const line = (record: unknown) => JSON.stringify(record);

test("the transcript reader pairs tool results with the calls that made them", () => {
  const { messages } = parseChatHistory(
    [
      line({ type: "system", content: "You are Grok." }),
      line({
        type: "user",
        content: [{ type: "text", text: "<user_query>Ship it.</user_query>" }],
      }),
      line({ type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] }),
      line({
        type: "assistant",
        content: "Editing.",
        tool_calls: [
          { id: "call-1", name: "search_replace", arguments: '{"file_path":"/repo/a.ts"}' },
          { id: "call-2", name: "run_terminal_command", arguments: '{"command":"npm test"}' },
        ],
      }),
      line({ type: "tool_result", tool_call_id: "call-1", content: "edited" }),
      line({ type: "tool_result", tool_call_id: "call-2", content: "12 passed" }),
      line({ type: "backend_tool_call", kind: {} }),
      line({ type: "assistant", content: "Done and committed." }),
    ].join("\n"),
  );
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "assistant"],
  );
  assert.deepEqual(
    messages[1]?.toolUses.map((use) => [use.tool, use.text]),
    [
      ["search_replace", "edited"],
      ["run_terminal_command", "12 passed"],
    ],
  );
  assert.deepEqual(messages[1]?.toolUses[0]?.input, { file_path: "/repo/a.ts" });
});

test("shell redirection, tee, and sed -i feed the saved-artifact list", () => {
  const { messages } = parseChatHistory(
    [
      line({ type: "system", content: "You are Grok." }),
      line({
        type: "assistant",
        content: "Saving the findings.",
        tool_calls: [
          {
            id: "call-1",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "echo hi > docs/out.md" }),
          },
          {
            id: "call-2",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "cat in.txt | tee copy.txt" }),
          },
          {
            id: "call-3",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "sed -i -e 's/a/b/' notes.md" }),
          },
          {
            id: "call-4",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "echo hi >| clobber.txt" }),
          },
          {
            id: "call-5",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "sed --in-place 's/a/b/' in-place-long.txt" }),
          },
          {
            id: "call-6",
            name: "run_terminal_command",
            arguments: JSON.stringify({
              command: "sed --in-place=.bak 's/a/b/' in-place-suffix.txt",
            }),
          },
          {
            id: "call-7",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "sed -i 's/a/b/' in-place-ambiguous.txt" }),
          },
        ],
      }),
      line({ type: "tool_result", tool_call_id: "call-1", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-2", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-3", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-4", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-5", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-6", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-7", content: "ok" }),
    ].join("\n"),
  );
  assert.deepEqual(snapshot(messages).state.savedArtifacts, [
    "docs/out.md",
    "copy.txt",
    "notes.md",
    "clobber.txt",
    "in-place-long.txt",
    "in-place-suffix.txt",
  ]);
});

test("tee and in-place sed after a bash reserved word feed the saved-artifact list", () => {
  const { messages } = parseChatHistory(
    [
      line({ type: "system", content: "You are Grok." }),
      line({
        type: "assistant",
        content: "Saving the findings.",
        tool_calls: [
          // Near misses: after a reserved word the next word is not the tee/sed command.
          {
            id: "call-1",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "if [ -f a ]; then cat out.txt; fi" }),
          },
          {
            id: "call-2",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "for tee in a b; do :; done" }),
          },
          {
            id: "call-3",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "if grep -q sed notes.md; then :; fi" }),
          },
          {
            id: "call-4",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "if [ -f a ]; then tee out.txt; fi" }),
          },
          {
            id: "call-5",
            name: "run_terminal_command",
            arguments: JSON.stringify({
              command: "if [ -f a ]; then sed -i -e s/a/b/ notes.md; fi",
            }),
          },
          {
            id: "call-6",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "for i in 1; do tee t.txt; done" }),
          },
          {
            id: "call-7",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "{ tee brace.txt; }" }),
          },
        ],
      }),
      line({ type: "tool_result", tool_call_id: "call-1", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-2", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-3", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-4", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-5", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-6", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-7", content: "ok" }),
    ].join("\n"),
  );
  assert.deepEqual(snapshot(messages).state.savedArtifacts, [
    "out.txt",
    "notes.md",
    "t.txt",
    "brace.txt",
  ]);
});

test("a shell command that writes nothing adds no saved artifact", () => {
  const { messages } = parseChatHistory(
    [
      line({
        type: "assistant",
        content: "Running the checks.",
        tool_calls: [
          { id: "call-1", name: "run_terminal_command", arguments: '{"command":"npm test"}' },
          {
            id: "call-2",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "cat <<EOF\nfake > nope.txt\nEOF" }),
          },
          {
            id: "call-3",
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: 'echo hi >> "$TARGET"' }),
          },
        ],
      }),
      line({ type: "tool_result", tool_call_id: "call-1", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-2", content: "ok" }),
      line({ type: "tool_result", tool_call_id: "call-3", content: "ok" }),
    ].join("\n"),
  );
  assert.deepEqual(snapshot(messages).state.savedArtifacts, []);
});

test("a record the reader cannot use is skipped, not guessed at", () => {
  const { messages, unreadableLines } = parseChatHistory(
    [
      "not json at all",
      line({ type: "assistant", content: 42 }),
      line({ type: "assistant", content: "kept", tool_calls: [{ name: 7 }] }),
      line({ type: "user", content: "a bare string" }),
      line({ type: "something_new", content: "from a later Grok" }),
    ].join("\n"),
  );
  assert.equal(unreadableLines, 1);
  assert.deepEqual(
    messages.map((message) => message.text),
    ["kept", "a bare string"],
  );
  assert.deepEqual(messages[0]?.toolUses, []);
});

test("a non-text user block is reported rather than silently dropped", () => {
  const { messages, hasImages } = parseChatHistory(
    line({
      type: "user",
      content: [
        { type: "image", source: {} },
        { type: "text", text: "<user_query>What is in this screenshot?</user_query>" },
      ],
    }),
  );
  assert.equal(hasImages, true);
  assert.equal(messages[0]?.text, "What is in this screenshot?");
});

test("the person's words are what Jev reads, not the harness envelopes around them", () => {
  assert.equal(
    userText("<user_info>OS: macos</user_info>\n<user_query>Fix the bug.</user_query>"),
    "Fix the bug.",
  );
  assert.equal(
    userText("<user_query>First.</user_query>\n<user_query>Then this.</user_query>"),
    "First.\n\nThen this.",
  );
  assert.equal(userText("<system-reminder>Skills: a, b</system-reminder>"), "");
  // A message with no envelope at all is the person speaking; keep it whole.
  assert.equal(userText("just ship it"), "just ship it");
});

test("a compaction summary is recognised the way the other hosts recognise it", () => {
  const { messages } = parseChatHistory(
    [
      line({
        type: "user",
        content: [
          {
            type: "text",
            text: "This session is being continued from a previous conversation that ran out of context. Summary: 1. Primary Request...",
          },
        ],
      }),
      line({ type: "assistant", content: "Picking it back up." }),
    ].join("\n"),
  );
  assert.equal(messages[0]?.role, "user");
  assert.match(messages[0]?.text ?? "", /^This session is being continued/);
});

test("the status row keeps the built-in segments it displaces, and omits what Grok did not send", () => {
  const payload = parsePayload(
    JSON.stringify({
      workspace: { current_dir: "/repo/project" },
      model: { display_name: "Grok 4.6" },
      context_window: { used_percentage: 61 },
    }),
  );
  assert.equal(itemsLine(payload), "project │ Grok 4.6 │ 61% ctx");
  assert.equal(
    itemsLine(parsePayload(JSON.stringify({ workspace: { current_dir: "/repo/project" } }))),
    "project",
  );
  assert.equal(itemsLine({}), "");
});

test("the hint is its own line, and the row never disappears when there is no hint", () => {
  const payload = parsePayload(JSON.stringify({ workspace: { current_dir: "/repo/project" } }));
  assert.equal(statusLine(payload, false, false), "project\n");
  assert.equal(statusLine(payload, true, false), `project\n${HINT}\n`);
  // A script that prints nothing takes the row away; an empty items line still keeps it.
  assert.equal(statusLine({}, false, false), "\n");
});

test("unusable status-line input paints the built-ins rather than an error", () => {
  assert.deepEqual(parsePayload("not json"), {});
  assert.deepEqual(parsePayload("[1,2]"), {});
  assert.equal(statusLine(parsePayload("not json"), false, false), "\n");
});

test("payload-derived status segments cannot inject extra lines or escapes", () => {
  const payload = parsePayload(
    JSON.stringify({
      workspace: { current_dir: "/repo/evil\nFAKE\u001b[31m" },
      model: { display_name: "Grok\r\n4.6\u0007" },
      context_window: { used_percentage: 10 },
    }),
  );
  const line = itemsLine(payload);
  assert.equal(line.includes("\n"), false);
  assert.equal(line.includes("\r"), false);
  assert.equal(line.includes("\u001b"), false);
  assert.equal(line.includes("\u0007"), false);
  const row = statusLine(payload, false, false);
  assert.equal(row.split("\n").length, 2);
});

test("a verdict expires with the turn, the window, and the clock", () => {
  const now = 1_000_000_000;
  const verdict: Verdict = {
    version: 1,
    sessionId: "s",
    promptId: "prompt-1",
    at: now,
    tokens: 100000,
    score: 0.9,
    floor: 0.8,
  };
  assert.equal(verdictApplies(verdict, now, undefined, 100000), true);
  assert.equal(verdictApplies(verdict, now, "prompt-1", 100000), true);
  assert.equal(verdictApplies(verdict, now, "prompt-2", 100000), false, "the next turn retires it");
  assert.equal(verdictApplies(verdict, now, undefined, 40000), false, "a compaction retires it");
  assert.equal(
    verdictApplies(verdict, now + 7 * 60 * 60 * 1000, undefined, 100000),
    false,
    "age retires it",
  );
  // A verdict with no numbers to compare against still shows; the hooks retire it instead.
  assert.equal(
    verdictApplies({ ...verdict, promptId: null, tokens: null }, now, "prompt-9", 10),
    true,
  );
});

test("unknown usage takes the strictest floor rather than a guess", () => {
  assert.ok(Number.isNaN(usageFraction({ source: "unknown" }, 0)));
  assert.ok(Number.isNaN(usageFraction({ source: "unknown" }, 450000)));
  assert.ok(Number.isNaN(usageFraction({ tokens: 10, source: "signals" }, 0)));
  assert.equal(usageFraction({ tokens: 50000, window: 500000, source: "signals" }, 0), 0.1);
  // A budget replaces the window, and needs no window to be known.
  assert.equal(usageFraction({ tokens: 50000, window: 500000, source: "signals" }, 100000), 0.5);
  assert.equal(usageFraction({ tokens: 50000, source: "signals" }, 100000), 0.5);
  assert.equal(parseBudget(" 450000 "), 450000);
  assert.equal(parseBudget("off"), 0);
  for (const bad of ["", "-1", "1.5", "450k"]) assert.throws(() => parseBudget(bad), bad);
  assert.throws(() => parseSettings({ version: 1, contextBudgetTokens: -1 }), /context budget/);
  assert.equal(readSignalsUsage(undefined).source, "unknown");
  assert.deepEqual(readPayloadUsage({ context_window: { context_tokens: 7 } }), {
    tokens: 7,
    source: "status-line",
  });
  assert.equal(readPayloadUsage({ context_window: { context_tokens: "lots" } }).source, "unknown");
});

test("this host refuses automatic mode by name instead of pretending to have it", () => {
  assert.throws(() => parseMode("auto"), /not available on Grok/);
  assert.throws(() => parseMode("sometimes"), SettingsError);
  assert.equal(parseMode(" HINT "), "hint");
  assert.equal(parseMode("off"), "off");
});

test("settings defaults fill in, and a field of the wrong kind is reported", () => {
  assert.deepEqual(parseSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings({ version: 1 }), DEFAULT_SETTINGS);
  assert.equal(parseSettings({ version: 1, minContextTokens: 60000 }).minContextTokens, 60000);
  assert.throws(() => parseSettings({ version: 2 }), SettingsError);
  assert.throws(() => parseSettings({ version: 1, minContextTokens: -1 }), SettingsError);
  assert.throws(() => parseSettings({ version: 1, logRequests: "yes" }), SettingsError);
  assert.deepEqual(parseSettings({ version: 1, statusLineItems: ["weather"] }), DEFAULT_SETTINGS);
});

test("settings default only when the file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "compact-adviser-settings-"));
  try {
    assert.deepEqual(readSettings(join(dir, "missing.json")), DEFAULT_SETTINGS);
    const blocked = join(dir, "settings.json");
    mkdirSync(blocked);
    assert.throws(() => readSettings(blocked), /Cannot read the compact-adviser settings file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
