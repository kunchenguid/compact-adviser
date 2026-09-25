// The settings command for the Codex adapter.
//
// Codex has no way for a plugin to register a slash command with code behind it: custom
// prompts are deprecated and skills expand into a prompt the model acts on. So settings live
// in this small CLI, which a person can run directly and which the bundled `compact-adviser`
// skill tells Codex to run on their behalf.
//
// It never prints a key: `status` reports only which source the key in effect came from.

import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { effectiveBudget } from "./checkpoint.ts";
import {
  AUTO_UNAVAILABLE,
  ConfigStore,
  DEFAULT_MINIMUM,
  formatTokens,
  type Mode,
  parseBudget,
  parseMinimum,
  parseMode,
  parseSavedApiKey,
} from "./config.ts";
import { DISABLE_ENV, disabledByEnv } from "./disable.ts";
import { formatKeyStatus } from "./env.ts";
import { resolveKey } from "./hook.ts";
import { floorFor } from "./judge.ts";
import { requestLogPath } from "./log.ts";
import { adviserRoot } from "./paths.ts";
import { parseProfile } from "./profile.ts";
import { usageFraction } from "./rollout.ts";
import { cooldownReason } from "./state.ts";
import { SessionStore } from "./store.ts";

export const USAGE = `compact-adviser (Codex) - suggests /compact at a completed checkpoint.

Usage: compact-adviser <command> [value]

  status                    Mode, minimum, key source, and the latest session's cooldown
  hint                      Advise with a hint at eligible checkpoints (default)
  off                       Stop advising; Codex's own compaction is unaffected
  threshold <tokens>        Save an absolute token minimum, or "default" for ${DEFAULT_MINIMUM}
  budget <tokens|off>       Relax the hint floor toward this context size, or the window if smaller
  log <on|off>              Log each TypeSafe request and its outcome to a local jsonl file
  key <set|clear|status>    Save, clear, or report the TypeSafe API key (never printed)

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
      : latest.tokens === undefined
        ? "Waiting for fresh model usage."
        : (cooldownReason(latest.state, latest.tokens, now) ??
          "No cooldown; semantic checks still apply.");
  const budget = config.contextBudgetTokens;
  const usage = latest === undefined ? Number.NaN : usageFraction(latest, budget);
  const window = Number.isFinite(usage)
    ? ` Context: ${formatTokens(latest?.tokens ?? 0)} tokens, ${Math.round(usage * 100)}% of the ${effectiveBudget(latest?.window ?? Number.NaN, budget) > 0 ? "budget" : "window"}; hint floor ${floorFor(usage, parseProfile(config.profile)).toFixed(2)}.`
    : "";
  return [
    `Mode: ${config.mode}.`,
    `Minimum: ${formatTokens(config.minContextTokens)} tokens.`,
    `Budget: ${budget > 0 ? `${formatTokens(budget)} tokens` : "off"}.`,
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

function saveBudget(environment: CliEnvironment, value: string): string {
  const count = parseBudget(value);
  new ConfigStore(adviserRoot(environment.env)).update({ contextBudgetTokens: count });
  return count > 0
    ? `Context budget saved: ${formatTokens(count)} tokens (all sessions).`
    : "Context budget off (all sessions): the hint floor follows the model's window.";
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

export async function run(argv: readonly string[], environment: CliEnvironment): Promise<string> {
  if (disabledByEnv(environment.env[DISABLE_ENV])) return "";
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
    case "budget":
      if (!value) throw new Error("Enter a token count, or off.");
      return saveBudget(environment, value);
    case "log":
      return saveLog(environment, value);
    case "key":
      return changeKey(environment, value);
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
  const rl = createInterface({
    input: process.stdin,
    output: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    terminal: Boolean(process.stdin.isTTY),
  });
  try {
    process.stderr.write(prompt);
    const value = await rl.question("");
    process.stderr.write("\n");
    return value;
  } finally {
    rl.close();
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  if (disabledByEnv(process.env[DISABLE_ENV])) return;
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
