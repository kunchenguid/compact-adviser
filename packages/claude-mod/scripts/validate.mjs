// `claude plugin validate --strict` on this package: the engine's own reading of the hooks
// module must name exactly the events it hooks, the environment it reads, and no
// capability the mod must not use.
import { claudeVersion, PACKAGE, run } from "./common.mjs";

const version = claudeVersion();
const { status, output } = run(["plugin", "validate", "--strict", PACKAGE]);
const hooksUnquoted =
  "hooks: session.start, prompt.submit, command.run, turn.start, turn.complete, session.compact, command.run{command=compact-adviser}, config.describe{key=compact-adviser.typesafeApiKey}, ui.close{id=compact-adviser}, ui.render{component=Pane}";
// Measured, not assumed: pinned CI Claude Code 2.1.275 prints the key unquoted;
// Claude Code 2.1.295 prints it quoted. Accept either.
const hooksQuoted = hooksUnquoted.replace(
  "config.describe{key=compact-adviser.typesafeApiKey}",
  'config.describe{key="compact-adviser.typesafeApiKey"}',
);
const expected = [
  "env reads: CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, COMPACT_ADVISER_DISABLE, COMPACT_ADVISER_TEST_ENDPOINT, HOME, TYPESAFE_API_KEY, TYPESAFE_BASE",
  "env writes: nothing",
  "$.fs.read (via appendTypeSafeLog, resolvedKey)",
  "$.fs.write (via appendTypeSafeLog)",
  "Validation passed",
];
// `prompt.submit` is intentional: confirmed auto mode may submit `beforeCompactPrompt`.
// A leading slash is `command.run` instead; Claude Code rejects that text on prompt.submit.
const forbidden = ["process.run", "env.set", "prompt.fill", "tool.call", "model."];
const problems = [
  ...(status === 0 ? [] : [`exit status ${status}`]),
  ...(output.includes(hooksUnquoted) || output.includes(hooksQuoted)
    ? []
    : [`missing hooks line (prompt.submit, and the other registered events)`]),
  ...expected.filter((line) => !output.includes(line)).map((line) => `missing: ${line}`),
  ...forbidden
    .filter((call) => output.includes(`$.${call}`))
    .map((call) => `forbidden call: $.${call}`),
];
if (problems.length > 0) {
  process.stderr.write(`${output}\n`);
  console.error(`Claude Code ${version}: strict validation drifted:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `Claude Code ${version}: strict validation passed with the expected hooks and environment reads.`,
);
