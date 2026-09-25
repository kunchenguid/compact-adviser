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
import { SUMMARY_PREFIX, snapshot } from "../src/snapshot.ts";
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

test("an outer compacted record replaces earlier history with its replacement and summary", () => {
  const rollout = mapRecords([
    sessionMeta(),
    userMessage("old ask that must not survive"),
    toolCall("apply_patch", "*** Begin Patch\n*** Update File: src/old.ts\n*** End Patch"),
    toolOutput("Applied old."),
    assistantMessage("old answer"),
    {
      type: "compacted",
      payload: {
        message: `${SUMMARY_PREFIX}\nparser work so far`,
        replacement_history: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Ship the remaining tests." }],
          },
        ],
      },
    },
    assistantMessage("Done: tests pass."),
    tokenCount(50000),
  ]);
  assert.equal(rollout.originator, "codex-tui");
  assert.equal(rollout.tokens, 50000);
  assert.ok(!rollout.messages.some((m) => m.text.includes("old ask")));
  assert.ok(
    !rollout.messages.some((m) => m.toolUses.some((use) => use.paths?.includes("src/old.ts"))),
  );
  assert.ok(
    rollout.messages.some(
      (m) =>
        m.role === "user" &&
        m.text.startsWith(SUMMARY_PREFIX) &&
        m.text.includes("parser work so far"),
    ),
  );
  assert.deepEqual(
    rollout.messages.map((m) => m.text),
    ["Ship the remaining tests.", `${SUMMARY_PREFIX}\nparser work so far`, "Done: tests pass."],
  );
});

test("a malformed compacted record drops pre-compaction context instead of keeping it", () => {
  const rollout = mapRecords([
    userMessage("stale pre-compaction ask"),
    assistantMessage("stale pre-compaction answer"),
    { type: "compacted", payload: { replacement_history: "not-an-array" } },
    assistantMessage("after compact"),
  ]);
  assert.ok(!rollout.messages.some((m) => m.text.includes("stale")));
  assert.deepEqual(
    rollout.messages.map((m) => m.text),
    ["after compact"],
  );
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

test("a string tool output with a non-zero process exit is an error", () => {
  const rollout = mapRecords([
    {
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "call_1" },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_1",
        output: JSON.stringify({
          output: "command failed",
          metadata: { exit_code: 1, duration_seconds: 0.2 },
        }),
      },
    },
  ]);
  assert.equal(rollout.messages[0]?.toolUses[0]?.isError, true);
  assert.ok(rollout.messages[0]?.toolUses[0]?.text?.includes("command failed"));
});

test("a content-array tool output with a non-zero process exit is an error", () => {
  const rollout = mapRecords([
    toolCall("shell", "{}"),
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_text",
            text: JSON.stringify({
              output: "command failed",
              metadata: { exit_code: 1, duration_seconds: 0.2 },
            }),
          },
        ],
      },
    },
  ]);
  assert.equal(rollout.messages[0]?.toolUses[0]?.isError, true);
  assert.ok(rollout.messages[0]?.toolUses[0]?.text?.includes("command failed"));
});

test("a plain-text process envelope with a non-zero exit is an error", () => {
  const rollout = mapRecords([
    {
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "call_1" },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_1",
        output: "Process exited with code 1\nFinal output:\ncommand failed",
      },
    },
  ]);
  assert.equal(rollout.messages[0]?.toolUses[0]?.isError, true);
  assert.ok(rollout.messages[0]?.toolUses[0]?.text?.includes("command failed"));
});

test("a prefixed plain-text process envelope with a non-zero exit is an error", () => {
  const rollout = mapRecords([
    toolCall("shell", "{}"),
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_text",
            text: [
              "Script completed",
              "Wall time 0.1 seconds",
              "Output:",
              "command failed",
              "Process exited with code 1",
            ].join("\n"),
          },
        ],
      },
    },
  ]);
  assert.equal(rollout.messages[0]?.toolUses[0]?.isError, true);
  assert.ok(rollout.messages[0]?.toolUses[0]?.text?.includes("command failed"));
});

test("a plain-text process envelope with exit code 0 is not an error", () => {
  const rollout = mapRecords([
    toolCall("shell", "{}"),
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_text",
            text: "Process exited with code 0\nFinal output:\nok",
          },
        ],
      },
    },
  ]);
  assert.equal(rollout.messages[0]?.toolUses[0]?.isError, undefined);
  assert.ok(rollout.messages[0]?.toolUses[0]?.text?.includes("ok"));
});

test("a content-array plain-text process envelope with a non-zero exit is an error", () => {
  const rollout = mapRecords([
    toolCall("shell", "{}"),
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_text",
            text: "Process exited with code 1\nFinal output:\ncommand failed",
          },
        ],
      },
    },
  ]);
  assert.equal(rollout.messages[0]?.toolUses[0]?.isError, true);
  assert.ok(rollout.messages[0]?.toolUses[0]?.text?.includes("command failed"));
});

test("usage comes from the last token_count record and degrades to NaN", () => {
  const rollout = mapRecords([tokenCount(10), tokenCount(95941, 258400)]);
  assert.equal(rollout.tokens, 95941);
  assert.equal(rollout.window, 258400);
  assert.equal(usageFraction(rollout, 0), 95941 / 258400);
  // A budget replaces the window as the denominator.
  assert.equal(usageFraction(rollout, 120000), 95941 / 120000);
  assert.ok(Number.isNaN(usageFraction({ tokens: 5, window: 0 }, 0)));
  assert.ok(Number.isNaN(usageFraction({ tokens: undefined, window: 1000 }, 120000)));
  assert.ok(Number.isNaN(usageFraction(mapRecords([]), 0)));
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

test("tee and in-place sed after a bash reserved word feed the saved artifacts", () => {
  const shell = (script: string, id: string) =>
    toolCall("shell", JSON.stringify({ command: ["bash", "-lc", script] }), id);
  const rollout = mapRecords([
    // Near misses: after a reserved word the next word is not the tee/sed command.
    shell("if [ -f a ]; then cat out.txt; fi", "call_1"),
    toolOutput("done", "call_1"),
    shell("for tee in a b; do :; done", "call_2"),
    toolOutput("done", "call_2"),
    shell("if grep -q sed notes.md; then :; fi", "call_3"),
    toolOutput("done", "call_3"),
    shell("if [ -f a ]; then tee out.txt; fi", "call_4"),
    toolOutput("done", "call_4"),
    shell("if [ -f a ]; then sed -i -e s/a/b/ notes.md; fi", "call_5"),
    toolOutput("done", "call_5"),
    shell("for i in 1; do tee t.txt; done", "call_6"),
    toolOutput("done", "call_6"),
    shell("{ tee brace.txt; }", "call_7"),
    toolOutput("done", "call_7"),
  ]);
  assert.deepEqual(snapshot(rollout.messages).state.savedArtifacts, [
    "out.txt",
    "notes.md",
    "t.txt",
    "brace.txt",
  ]);
});

test("an apply_patch move stops listing the source as a saved artifact", () => {
  const rollout = mapRecords([
    toolCall(
      "apply_patch",
      ["*** Begin Patch", "*** Update File: old.ts", "*** Move to: new.ts", "*** End Patch"].join(
        "\n",
      ),
    ),
    toolOutput("Applied."),
  ]);
  assert.deepEqual(rollout.messages[0]?.toolUses[0]?.paths, ["new.ts"]);
  assert.deepEqual(rollout.messages[0]?.toolUses[0]?.removedPaths, ["old.ts"]);
  assert.deepEqual(snapshot(rollout.messages).state.savedArtifacts, ["new.ts"]);
});

test("an apply_patch delete removes a previously saved artifact", () => {
  const rollout = mapRecords([
    toolCall("apply_patch", "*** Begin Patch\n*** Add File: gone.ts\n*** End Patch", "call_1"),
    toolOutput("Applied.", "call_1"),
    toolCall("apply_patch", "*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch", "call_2"),
    toolOutput("Applied.", "call_2"),
  ]);
  assert.deepEqual(snapshot(rollout.messages).state.savedArtifacts, []);
});

test("shell redirection, tee, and sed -i in a shell call feed the saved artifacts", () => {
  const shell = (script: string, id: string) =>
    toolCall("shell", JSON.stringify({ command: ["bash", "-lc", script] }), id);
  const rollout = mapRecords([
    shell("echo hi > src/gen.ts", "call_1"),
    toolOutput("done", "call_1"),
    shell("cat in.txt | tee copy.txt", "call_2"),
    toolOutput("done", "call_2"),
    shell("sed -i -e 's/a/b/' notes.md", "call_3"),
    toolOutput("done", "call_3"),
    shell("echo hi >| clobber.txt", "call_4"),
    toolOutput("done", "call_4"),
    shell("sed --in-place 's/a/b/' in-place-long.txt", "call_5"),
    toolOutput("done", "call_5"),
    shell("sed --in-place=.bak 's/a/b/' in-place-suffix.txt", "call_6"),
    toolOutput("done", "call_6"),
    shell("sed -i 's/a/b/' in-place-ambiguous.txt", "call_7"),
    toolOutput("done", "call_7"),
  ]);
  assert.deepEqual(snapshot(rollout.messages).state.savedArtifacts, [
    "src/gen.ts",
    "copy.txt",
    "notes.md",
    "clobber.txt",
    "in-place-long.txt",
    "in-place-suffix.txt",
  ]);
});

test("a shell call that writes nothing, or fails, adds no saved artifact", () => {
  const shell = (script: string, id: string) =>
    toolCall("shell", JSON.stringify({ command: ["bash", "-lc", script] }), id);
  const rollout = mapRecords([
    shell("cat <<EOF\nfake > nope.txt\nEOF", "call_1"),
    toolOutput("done", "call_1"),
    toolCall("shell", JSON.stringify({ command: ["npm", "test"] }), "call_2"),
    toolOutput("ok", "call_2"),
    shell("echo hi > $TARGET", "call_3"),
    toolOutput("done", "call_3"),
    shell("echo hi > out.txt", "call_4"),
    toolOutput("Process exited with code 1", "call_4"),
  ]);
  assert.deepEqual(snapshot(rollout.messages).state.savedArtifacts, []);
});

test("an argv array without a shell wrapper adds no saved artifact", () => {
  const rollout = mapRecords([
    toolCall("shell", JSON.stringify({ command: ["rg", "=>", "src"] }), "call_1"),
    toolOutput("done", "call_1"),
    toolCall("local_shell", JSON.stringify({ command: ["tee", "copy.txt"] }), "call_2"),
    toolOutput("done", "call_2"),
    toolCall(
      "shell",
      JSON.stringify({ command: ["python3", "-c", "print(len(x) > 0)"] }),
      "call_3",
    ),
    toolOutput("done", "call_3"),
  ]);
  assert.deepEqual(snapshot(rollout.messages).state.savedArtifacts, []);
});

test("shell redirection, tee, and sed -i in Codex's exec program feed the saved artifacts", () => {
  // Codex 0.155+ records shell work as a custom_tool_call named `exec` whose input is a small
  // JavaScript program calling tools.exec_command; the shell line sits in its `cmd` field.
  const exec = (cmd: string, id: string) =>
    toolCall(
      "exec",
      `const r = await tools.exec_command({"cmd":${JSON.stringify(cmd)},"workdir":"/home/me/code","yield_time_ms":10000,"max_output_tokens":20000}); text(r.output);\n`,
      id,
    );
  const rollout = mapRecords([
    exec("echo hi > src/gen.ts", "call_1"),
    toolOutput("done", "call_1"),
    exec("cat in.txt | tee copy.txt", "call_2"),
    toolOutput("done", "call_2"),
    exec("sed -i -e 's/a/b/' notes.md", "call_3"),
    toolOutput("done", "call_3"),
    exec("echo hi >| clobber.txt", "call_4"),
    toolOutput("done", "call_4"),
    exec("sed --in-place 's/a/b/' in-place-long.txt", "call_5"),
    toolOutput("done", "call_5"),
    exec("sed --in-place=.bak 's/a/b/' in-place-suffix.txt", "call_6"),
    toolOutput("done", "call_6"),
    exec("sed -i 's/a/b/' in-place-ambiguous.txt", "call_7"),
    toolOutput("done", "call_7"),
  ]);
  assert.deepEqual(snapshot(rollout.messages).state.savedArtifacts, [
    "src/gen.ts",
    "copy.txt",
    "notes.md",
    "clobber.txt",
    "in-place-long.txt",
    "in-place-suffix.txt",
  ]);
});

test("an exec call that reads, or writes nothing, adds no saved artifact", () => {
  const exec = (cmd: string, id: string) =>
    toolCall(
      "exec",
      `const r = await tools.exec_command({"cmd":${JSON.stringify(cmd)},"workdir":"/home/me/code","yield_time_ms":10000,"max_output_tokens":20000}); text(r.output);\n`,
      id,
    );
  const rollout = mapRecords([
    exec("sed -n '1,240p' notes.md", "call_1"),
    toolOutput("the file contents", "call_1"),
    exec("cat <<EOF\nfake > nope.txt\nEOF", "call_2"),
    toolOutput("done", "call_2"),
    exec('python3 -c "print(len(x) > 0)"', "call_3"),
    toolOutput("true", "call_3"),
    exec("echo hi > $TARGET", "call_4"),
    toolOutput("done", "call_4"),
  ]);
  assert.deepEqual(snapshot(rollout.messages).state.savedArtifacts, []);
});

test("the exec spellings Codex really emits feed the saved artifacts", () => {
  const call = (program: string, id: string) => [
    toolCall("exec", program, id),
    toolOutput("done", id),
  ];
  const rollout = mapRecords([
    // No final semicolon after the output use.
    ...call(
      'const r = await tools.exec_command({"cmd":"echo hi > spaced.txt"}); text(r.output)\n',
      "call_1",
    ),
    // No spaces around `=`, and the output use on its own line.
    ...call(
      'const r=await tools.exec_command({"cmd":"echo hi > tight.txt"});\ntext(r.output);\n',
      "call_2",
    ),
    // A binding named something other than `r`.
    ...call(
      'const out = await tools.exec_command({"cmd":"echo hi > named.txt"}); text(out.output);\n',
      "call_3",
    ),
    // Bare identifier keys, as Codex writes them most often.
    ...call(
      'const r = await tools.exec_command({ cmd: "echo hi > loose.txt", workdir: "/home/me" }); text(r.output);\n',
      "call_4",
    ),
    // Identifier and JSON string keys mixed, around a nested literal and an array value.
    ...call(
      'const r = await tools.exec_command({cmd:"echo hi > mixed.txt","env":{PATH:"/bin"},argv:["a","b"]}); text(r.output);\n',
      "call_5",
    ),
  ]);
  assert.deepEqual(snapshot(rollout.messages).state.savedArtifacts, [
    "spaced.txt",
    "tight.txt",
    "named.txt",
    "loose.txt",
    "mixed.txt",
  ]);
});

test("an exec program beyond the one exec_command call form adds no saved artifact", () => {
  const rollout = mapRecords([
    // The apply_patch program variant Codex sends under the same `exec` name.
    toolCall(
      "exec",
      'const patch = "*** Begin Patch\\n*** Add File: sneaky.ts\\n*** End Patch";\ntext(await tools.apply_patch(patch));\n',
      "call_1",
    ),
    toolOutput("Applied.", "call_1"),
    // A statement between the call and the output use is not the recognised form.
    toolCall(
      "exec",
      'const r = await tools.exec_command({"cmd":"echo hi > guarded.txt"}); if (r.exit_code) text("failed"); text(r.output);\n',
      "call_2",
    ),
    toolOutput("done", "call_2"),
    // `cmd:` text inside another key's string value is not a `cmd` key, so nothing is written.
    toolCall(
      "exec",
      'const r = await tools.exec_command({workdir:"/home/me", note:"cmd: \\"echo hi > trap.txt\\""}); text(r.output);\n',
      "call_3",
    ),
    toolOutput("done", "call_3"),
    // A literal JSON.parse still cannot decode — here, a bare identifier value — is dropped.
    toolCall(
      "exec",
      "const r = await tools.exec_command({ cmd: line }); text(r.output);\n",
      "call_9",
    ),
    toolOutput("done", "call_9"),
    // A spread element is beyond the recognised literal, so it is dropped.
    toolCall(
      "exec",
      'const r = await tools.exec_command({ ...base, cmd: "echo hi > spread.txt" }); text(r.output);\n',
      "call_10",
    ),
    toolOutput("done", "call_10"),
    // A `cmd` that is not a string is dropped.
    toolCall(
      "exec",
      'const r = await tools.exec_command({"cmd":["bash","-lc","echo hi > argv.txt"]}); text(r.output);\n',
      "call_4",
    ),
    toolOutput("done", "call_4"),
    // A call this parser cannot close — the object literal never ends — is dropped.
    toolCall(
      "exec",
      'const r = await tools.exec_command({"cmd":"echo hi > open.txt"); text(r.output);\n',
      "call_5",
    ),
    toolOutput("done", "call_5"),
    // An output use of a different binding than the call's is dropped.
    toolCall(
      "exec",
      'const r = await tools.exec_command({"cmd":"echo hi > other.txt"}); text(s.output);\n',
      "call_6",
    ),
    toolOutput("done", "call_6"),
    // A call without the `const <id> = await` binding is dropped.
    toolCall("exec", 'await tools.exec_command({"cmd":"echo hi > bare.txt"});\n', "call_7"),
    toolOutput("done", "call_7"),
    // An output use other than `<id>.output` is dropped.
    toolCall(
      "exec",
      'const r = await tools.exec_command({"cmd":"echo hi > chained.txt"}); text(r.output.text);\n',
      "call_8",
    ),
    toolOutput("done", "call_8"),
  ]);
  assert.deepEqual(snapshot(rollout.messages).state.savedArtifacts, []);
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
    assert.equal(rollout.truncated, true);
    const coverage = snapshot(rollout.messages, [], { truncated: rollout.truncated }).state
      .coverage;
    assert.equal(coverage.transcriptLimitReached, true);
    assert.ok(coverage.olderMessagesOmitted > 0);
  } finally {
    lab.cleanup();
  }
});

test("an image-only user message is kept and marks coverage as having images", () => {
  const rollout = mapRecords([
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,QQ==" }],
      },
    },
  ]);
  assert.equal(rollout.messages.length, 1);
  assert.equal(rollout.messages[0]?.role, "user");
  assert.equal(rollout.messages[0]?.hasImages, true);
  assert.equal(snapshot(rollout.messages).state.coverage.hasImages, true);
});

test("a mixed text-and-image user message keeps the text and marks images", () => {
  const rollout = mapRecords([
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Look at this screenshot." },
          { type: "input_image", image_url: "data:image/png;base64,QQ==" },
        ],
      },
    },
  ]);
  assert.equal(rollout.messages[0]?.text, "Look at this screenshot.");
  assert.equal(rollout.messages[0]?.hasImages, true);
  const view = snapshot(rollout.messages);
  assert.equal(view.state.coverage.hasImages, true);
  assert.equal(view.state.userConstraints[0]?.text, "Look at this screenshot.");
});

test("the first request after the latest compaction is the post-compaction baseline", () => {
  const compacted = { type: "compacted", payload: { replacement_history: [] } };
  assert.equal(
    mapRecords([tokenCount(300000), tokenCount(310000)]).tokensAfterCompaction,
    undefined,
  );
  const once = mapRecords([tokenCount(300000), compacted, tokenCount(60000), tokenCount(90000)]);
  assert.deepEqual([once.tokens, once.tokensAfterCompaction], [90000, 60000]);
  const twice = mapRecords([compacted, tokenCount(60000), compacted, tokenCount(40000)]);
  assert.equal(twice.tokensAfterCompaction, 40000);
  assert.equal(mapRecords([tokenCount(60000), compacted]).tokensAfterCompaction, undefined);
});
