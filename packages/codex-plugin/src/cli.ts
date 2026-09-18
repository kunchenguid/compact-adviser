// The settings command for the Codex adapter.
//
// Codex has no way for a plugin to register a slash command with code behind it: custom
// prompts are deprecated and skills expand into a prompt the model acts on. So settings live
// in this small CLI, which a person can run directly and which the bundled `compact-adviser`
// skill tells Codex to run on their behalf.
//
// It never prints a key: `status` reports only which source the key in effect came from.

import {
  AUTO_UNAVAILABLE,
  ConfigStore,
  DEFAULT_MINIMUM,
  formatTokens,
  type Mode,
  parseMinimum,
  parseMode,
  parseSavedApiKey,
} from "./config.ts";
import { formatKeyStatus } from "./env.ts";
import { resolveKey } from "./hook.ts";
import { floorFor } from "./judge.ts";
import { requestLogPath } from "./log.ts";
import { adviserRoot } from "./paths.ts";
import { usageFraction } from "./rollout.ts";
import { cooldownReason } from "./state.ts";
import { SessionStore } from "./store.ts";

export const USAGE = `compact-adviser (Codex) - suggests /compact at a completed checkpoint.

Usage: compact-adviser <command> [value]

  status                    Mode, minimum, key source, and the latest session's cooldown
  hint                      Advise with a hint at eligible checkpoints (default)
  off                       Stop advising; Codex's own compaction is unaffected
  threshold <tokens>        Save an absolute token minimum, or "default" for ${DEFAULT_MINIMUM}
  log <on|off>              Log each TypeSafe request and its outcome to a local jsonl file
  key <set|clear|status>    Save, clear, or report the TypeSafe API key (never printed)
  snooze                    Suppress advice for the next three completed exchanges
  dismiss                   Suppress advice until the next completed exchange

Automatic compaction is not available on Codex: nothing outside a session can run /compact.
A key may also come from TYPESAFE_API_KEY in the environment or a .env file in the session's
working directory; that takes precedence over the saved one.`;

export interface CliEnvironment {
  env: NodeJS.ProcessEnv;
  now: () => number;
  cwd: string;
  /** Reads a secret without echoing it; the CLI never takes a key as an argument. */
  readSecret: (prompt: string) => Promise<string>;
}

function statusText(environment: CliEnvironment): string {
  const root = adviserRoot(environment.env);
  const config = new ConfigStore(root).read();
  const key = resolveKey(environment.env, config.typesafeApiKey, environment.cwd);
  const store = new SessionStore(root);
  const latest = store.latest();
  const now = environment.now();
  const cooldown =
    latest === undefined
      ? "No session recorded yet."
      : (cooldownReason(latest.state, latest.tokens ?? 0, now) ??
        "No cooldown; semantic checks still apply.");
  const usage = latest === undefined ? Number.NaN : usageFraction(latest);
  const window = Number.isFinite(usage)
    ? ` Context: ${formatTokens(latest?.tokens ?? 0)} tokens, ${Math.round(usage * 100)}% of the window; hint floor ${floorFor(usage).toFixed(2)}.`
    : "";
  return [
    `Mode: ${config.mode}.`,
    `Minimum: ${formatTokens(config.minContextTokens)} tokens.`,
    `${formatKeyStatus(key.source)}.`,
    `${cooldown}${window}`,
    `Request log: ${config.logRequests ? requestLogPath(root, latest?.id ?? "<session>") : "off"}.`,
    `Settings file: ${new ConfigStore(root).path}.`,
  ].join(" ");
}

function saveMode(environment: CliEnvironment, mode: Mode): string {
  new ConfigStore(adviserRoot(environment.env)).update({ mode });
  return mode === "hint"
    ? "Hints only saved (all sessions). Codex's own compaction is unchanged."
    : "Off saved (all sessions). Codex's own compaction is unchanged.";
}

function saveThreshold(environment: CliEnvironment, value: string): string {
  const count = value === "default" ? DEFAULT_MINIMUM : parseMinimum(value);
  new ConfigStore(adviserRoot(environment.env)).update({ minContextTokens: count });
  return `Minimum context saved: ${formatTokens(count)} tokens (all sessions).`;
}

function saveLog(environment: CliEnvironment, value: string): string {
  if (value !== "on" && value !== "off") throw new Error("Enter on or off.");
  const root = adviserRoot(environment.env);
  new ConfigStore(root).update({ logRequests: value === "on" });
  return value === "on"
    ? `TypeSafe request logging on (all sessions). ${requestLogPath(root, "<session>")}`
    : "TypeSafe request logging off (all sessions).";
}

async function changeKey(environment: CliEnvironment, action: string): Promise<string> {
  const root = adviserRoot(environment.env);
  const store = new ConfigStore(root);
  if (action === "clear") {
    store.update({ typesafeApiKey: "" });
    return "Saved TypeSafe API key cleared (all sessions). Environment and .env still apply.";
  }
  if (action === "status" || action === "") {
    const config = store.read();
    return formatKeyStatus(
      resolveKey(environment.env, config.typesafeApiKey, environment.cwd).source,
    );
  }
  if (action !== "set") throw new Error("Use key set, key clear, or key status.");
  const value = parseSavedApiKey(await environment.readSecret("TypeSafe API key: "));
  store.update({ typesafeApiKey: value });
  return "TypeSafe API key saved (all sessions). Status shows the source, never the value.";
}

function suppress(environment: CliEnvironment, exchanges: number, message: string): string {
  const store = new SessionStore(adviserRoot(environment.env));
  const latest = store.latest();
  if (latest === undefined) return "No session recorded yet; nothing to suppress.";
  store.write(
    latest.id,
    {
      ...latest.state,
      snoozeUntil: latest.state.completed + exchanges,
      updatedAt: environment.now(),
    },
    latest,
  );
  return message;
}

export async function run(argv: readonly string[], environment: CliEnvironment): Promise<string> {
  const [command = "", value = ""] = argv;
  switch (command) {
    case "status":
      return statusText(environment);
    case "hint":
    case "off":
      return saveMode(environment, parseMode(command));
    case "auto":
      throw new Error(AUTO_UNAVAILABLE);
    case "threshold":
      if (!value) throw new Error("Enter a token count, or default.");
      return saveThreshold(environment, value);
    case "log":
      return saveLog(environment, value);
    case "key":
      return changeKey(environment, value);
    case "snooze":
      return suppress(environment, 4, "Advice snoozed for three completed exchanges.");
    case "dismiss":
      return suppress(environment, 1, "Advice suppressed until the next completed exchange.");
    case "":
    case "help":
    case "--help":
    case "-h":
      return USAGE;
    default:
      throw new Error(USAGE);
  }
}

async function readSecret(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    // The prompt goes to stderr and the typed value is never echoed back to stdout.
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  try {
    const message = await run(argv, {
      env: process.env,
      now: () => Date.now(),
      cwd: process.cwd(),
      readSecret,
    });
    process.stdout.write(`${message}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("cli.ts")) await main(process.argv.slice(2));
