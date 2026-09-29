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
import { DISABLE_ENV, disabledByEnv } from "./disable.ts";
import {
  formatJudgeStatus,
  formatKeyStatus,
  judgeSavedMessage,
  KEY_LABELS,
  PROVIDER_ENV,
  parseJudgeProvider,
  SAVED_KEY_FIELDS,
} from "./env.ts";
import { resolveKey, resolveProvider } from "./hook.ts";
import { floorFor } from "./judge.ts";
import { requestLogPath } from "./log.ts";
import { adviserRoot } from "./paths.ts";
import { parseProfile } from "./profile.ts";
import { usageFraction } from "./rollout.ts";
import { cooldownReason } from "./state.ts";
import { SessionStore } from "./store.ts";

export const USAGE = `compact-adviser (Codex) - suggests /compact at a completed checkpoint.

Usage: compact-adviser <command> [value]

  status                    Mode, minimum, judge, key source, and the latest session's cooldown
  hint                      Advise with a hint at eligible checkpoints (default)
  off                       Stop advising; Codex's own compaction is unaffected
  threshold <tokens>        Save an absolute token minimum, or "default" for ${DEFAULT_MINIMUM}
  log <on|off>              Log each TypeSafe request and its outcome to a local jsonl file
  judge <typesafe|vercel>   Ask Jev at TypeSafe (default) or through Vercel's AI Gateway
  key <set|clear|status>    Save, clear, or report the judge's API key (never printed)

Automatic compaction is not available on Codex: nothing outside a session can run /compact.
A key may also come from TYPESAFE_API_KEY (AI_GATEWAY_API_KEY for the gateway) in the
environment, which takes precedence over the saved one, or from a .env file in the session's
working directory. COMPACT_ADVISER_JUDGE_PROVIDER in the environment overrides the saved judge.`;

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
  const key = resolveKey(environment.env, config, environment.cwd);
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
    ? ` Context: ${formatTokens(latest?.tokens ?? 0)} tokens, ${Math.round(usage * 100)}% of the window; hint floor ${floorFor(usage, parseProfile(config.profile)).toFixed(2)}.`
    : "";
  return [
    `Mode: ${config.mode}.`,
    `Minimum: ${formatTokens(config.minContextTokens)} tokens.`,
    `${formatJudgeStatus(resolveProvider(environment.env, config))}.`,
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

function saveJudge(environment: CliEnvironment, value: string): string {
  const root = adviserRoot(environment.env);
  const provider = parseJudgeProvider(value);
  new ConfigStore(root).update({ judgeProvider: provider });
  return judgeSavedMessage(provider, environment.env[PROVIDER_ENV]);
}

/** The key commands act on the key of the judge in effect. */
async function changeKey(environment: CliEnvironment, action: string): Promise<string> {
  const root = adviserRoot(environment.env);
  const store = new ConfigStore(root);
  const config = store.read();
  if (action === "status" || action === "") {
    return formatKeyStatus(resolveKey(environment.env, config, environment.cwd).source);
  }
  if (action !== "set" && action !== "clear") {
    throw new Error("Use key set, key clear, or key status.");
  }
  const provider = resolveProvider(environment.env, config).provider;
  if (provider === undefined) {
    throw new Error(`${PROVIDER_ENV} names no provider; set it to typesafe or vercel first.`);
  }
  const label = KEY_LABELS[provider];
  if (action === "clear") {
    store.update({ [SAVED_KEY_FIELDS[provider]]: "" });
    return `Saved ${label} cleared (all sessions). Environment and .env still apply.`;
  }
  const value = parseSavedApiKey(await environment.readSecret(`${label}: `), label);
  store.update({ [SAVED_KEY_FIELDS[provider]]: value });
  return `${label} saved (all sessions). Status shows the source, never the value.`;
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
    case "log":
      return saveLog(environment, value);
    case "judge":
      if (!value) throw new Error("Enter typesafe or vercel.");
      return saveJudge(environment, value);
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
