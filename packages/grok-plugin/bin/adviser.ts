#!/usr/bin/env node
// compact-adviser for Grok Build: the one process behind both halves of the plugin.
//
// Grok has no in-process extension surface, so the product is two cooperating hooks into one
// CLI. `hook stop` judges a completed checkpoint and records a verdict; `status-line` paints
// the hint the person reads. The judgment, the scoring, and the usage-dependent floor are the
// shared product (../lib/judge.ts); everything in this file is Grok's own glue.
//
// One host fact shapes the install: Grok 1.0.34 discovers a plugin's `hooks/hooks.json` and
// lists it, but never loads it into a session, so the plugin alone cannot judge anything.
// `install` therefore registers the same handlers as a user hook file in
// `${GROK_HOME:-~/.grok}/hooks/compact-adviser.json`, which is always trusted and does load.
// Both copies are shipped, so the day Grok loads plugin hooks nothing has to change: the Stop
// gate records the turn it handled and refuses to judge it twice.
//
// Two rules shape it:
//   - Nothing here ever writes to the model's context. `hook stop` always exits 0 with no
//     stdout, so the Stop gate always allows: a hook could "block the stop" with a reason, but
//     that would put the hint in the model's context instead of the person's.
//   - Every path fails open and silent. A hook is on the turn's critical path, so an
//     unreadable transcript, an absent key, or a refused judgment leaves the turn alone.
//
// This file runs through Node's own type stripping, so it and ../lib carry no build step and
// no dependencies: an installed plugin is the files themselves.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { judged, resolve } from "../lib/checkpoint.ts";
import {
  DEFAULT_MINIMUM,
  formatTokens,
  parseMinimum,
  parseMode,
  parseSavedApiKey,
  readSettings,
  type Settings,
  SettingsError,
  STATUS_LINE_ITEMS,
  writeSettings,
} from "../lib/config.ts";
import { DISABLE_ENV, disabledByEnv } from "../lib/disable.ts";
import { formatKeyStatus, parseDotenvKey, resolveTypesafeApiKey } from "../lib/env.ts";
import {
  floorFor,
  judge,
  MAX_RESPONSE_BYTES,
  qualifies,
  requestBody,
  score,
} from "../lib/judge.ts";
import {
  errorLogLine,
  loggedJudgeErrorKind,
  requestLogLine,
  requestLogPath,
  responseLogLine,
} from "../lib/log.ts";
import {
  dataDir,
  type Env,
  sessionDir as findSessionDir,
  grokHome,
  sessionStatePath,
  settingsPath,
  verdictPath,
} from "../lib/paths.ts";
import { parseProfile } from "../lib/profile.ts";
import { snapshot } from "../lib/snapshot.ts";
import { backoff, completeExchange, cooldownReason, SESSION_RETENTION_MS } from "../lib/state.ts";
import { parsePayload, statusLine } from "../lib/statusline.ts";
import {
  clearDiagnostic,
  clearVerdict,
  diagnosticPath,
  loadDiagnostic,
  loadSessionState,
  loadVerdict,
  resetSessionState,
  saveDiagnostic,
  saveSessionState,
  saveVerdict,
  verdictApplies,
} from "../lib/store.ts";
import { readTranscript } from "../lib/transcript.ts";
import { readPayloadUsage, readSignalsUsage, usageFraction } from "../lib/usage.ts";

const LOOPBACK_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[\x21-\x7e]*$/;
/** The conversation's own tokens, below which there is nothing worth judging yet. */
const MINIMUM_CONVERSATION_TOKENS = 20000;
const USAGE = `compact-adviser (Grok)

  status                     what the adviser would do right now
  mode hint|off              hint shows advice; off disables it (Grok's own auto-compact is unaffected)
  threshold <tokens|default> minimum context tokens before a checkpoint is judged
  key <value>|key clear      save or clear the TypeSafe API key from a shell (TYPESAFE_API_KEY still wins)
  log on|off                 TypeSafe request logging, off by default
  snooze                     no advice for three more completed exchanges in this session
  dismiss                    take the current hint off the status row
  install                    register the hooks in your Grok home, then print the status-line block`;

// --- small helpers ------------------------------------------------------------------

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function out(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function env(): Env {
  return process.env;
}

function settingsOrThrow(): Settings {
  return readSettings(settingsPath(env()));
}

function updateSettings(patch: Partial<Settings>): Settings {
  const current = settingsOrThrow();
  const next: Settings = { ...current, ...patch, version: 1 };
  writeSettings(settingsPath(env()), next);
  return next;
}

function dotenvKey(cwd: string): string | undefined {
  try {
    return parseDotenvKey(readFileSync(join(cwd, ".env"), "utf8"), "TYPESAFE_API_KEY");
  } catch {
    return undefined;
  }
}

function resolveKey(settings: Settings, cwd: string) {
  return resolveTypesafeApiKey(
    process.env.TYPESAFE_API_KEY,
    settings.typesafeApiKey,
    dotenvKey(cwd),
  );
}

function testEndpoint(): string | undefined {
  const value = process.env.COMPACT_ADVISER_TEST_ENDPOINT;
  return value !== undefined && LOOPBACK_ENDPOINT.test(value) ? value : undefined;
}

async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return "x".repeat(MAX_RESPONSE_BYTES + 1);
      chunks.push(next.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

function cancellableJudgeTransport(): {
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ status: number; ok: boolean; text: string }>;
  sleep: (ms: number) => Promise<void>;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    fetch: async (url, init) => {
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const text = await readBoundedText(response);
        stopTimer();
        return { status: response.status, ok: response.ok, text };
      } catch (error) {
        stopTimer();
        if (controller.signal.aborted) {
          return await new Promise<{ status: number; ok: boolean; text: string }>(() => undefined);
        }
        throw error;
      }
    },
    sleep: (ms) =>
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timer = undefined;
          resolve();
          controller.abort();
        }, ms);
      }),
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function appendLog(sessionId: string, line: string): void {
  try {
    const path = requestLogPath(dataDir(env()), sessionId);
    mkdirSync(dataDir(env()), { recursive: true });
    // O_APPEND: each hook run is its own process, so a whole-file rewrite would lose lines.
    appendFileSync(path, line, { mode: 0o600 });
  } catch {
    // Logging must never replace or delay a judgment.
  }
}

function checkpointKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// --- hook payloads ------------------------------------------------------------------

interface HookPayload {
  hook_event_name?: string;
  sessionId?: string;
  cwd?: string;
  workspaceRoot?: string;
  promptId?: string;
  reason?: string;
  subagentType?: string;
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
  trigger?: string;
}

function hookPayload(): HookPayload {
  try {
    const value = JSON.parse(readStdin()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as HookPayload)
      : {};
  } catch {
    return {};
  }
}

function sessionIdOf(payload: HookPayload): string | undefined {
  const id = payload.sessionId ?? process.env.GROK_SESSION_ID;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function cwdOf(payload: HookPayload): string {
  return payload.cwd ?? payload.workspaceRoot ?? process.env.GROK_WORKSPACE_ROOT ?? process.cwd();
}

// --- the judgment -------------------------------------------------------------------

/**
 * A completed checkpoint. Returns nothing: every outcome is a file write, because the hook's
 * stdout is a control channel for the turn and this product never uses it.
 */
async function runStop(payload: HookPayload): Promise<void> {
  // A subagent's turn end is not the session's, and the session-end fire is not a checkpoint.
  if (payload.subagentType !== undefined) return;
  if (payload.reason !== "end_turn") return;
  // A continuation round: another Stop hook kept the agent working, so the turn is not over.
  if (payload.stopHookActive === true) return;
  const sessionId = sessionIdOf(payload);
  if (!sessionId) return;
  const cwd = cwdOf(payload);
  const now = Date.now();

  let settings: Settings;
  try {
    settings = settingsOrThrow();
  } catch {
    return;
  }
  const statePath = sessionStatePath(sessionId, env());
  const verdict = verdictPath(sessionId, env());
  const promptId = typeof payload.promptId === "string" ? payload.promptId : null;

  const stored = loadSessionState(statePath, now);
  // This turn has already been through the gate: a second registration of the same hook, or a
  // re-fire, must not count the exchange twice or ask TypeSafe twice for one checkpoint.
  if (promptId !== null && stored.lastPromptId === promptId) return;

  const dir = findSessionDir(cwd, sessionId, env());
  const usage = readSignalsUsage(dir);
  let state = { ...completeExchange(stored, usage.tokens, now), lastPromptId: promptId };
  saveSessionState(statePath, state);

  if (settings.mode === "off") {
    clearVerdict(verdict);
    return;
  }
  const key = resolveKey(settings, cwd);
  const activeKey = key.value?.trim() ?? "";
  if (!activeKey) return;

  const transcript = readTranscript(dir);
  if (transcript.unreadableLines !== 0) return;
  if (!transcript.messages.length) return;
  const view = snapshot(transcript.messages, [activeKey], transcript.hasImages);

  // `contextTokensUsed` is the honest number when signals.json is readable; the local estimate
  // stands in when it is not, so an undocumented field going away weakens the gate, not the product.
  const tokens = usage.tokens ?? view.conversationTokens;
  if (state.compacted && state.baseline === null) {
    // No readable usage after the compaction: the same estimate the gate reads is the baseline.
    state = { ...state, baseline: tokens };
    saveSessionState(statePath, state);
  }
  if (view.conversationTokens <= MINIMUM_CONVERSATION_TOKENS) return;
  if (tokens < settings.minContextTokens) return;
  if (cooldownReason(state, tokens, now) !== undefined) return;

  const profile = parseProfile(settings.profile);
  const fingerprint = checkpointKey(view.checkpointText);
  if (state.lastHintKey === fingerprint) return;

  let loggedBody: string | undefined;
  if (settings.logRequests) {
    try {
      loggedBody = requestBody(view.state, profile);
      appendLog(sessionId, requestLogLine(loggedBody));
    } catch {
      // A body too large to send is reported by `judge` below; logging does not decide.
    }
  }
  const endpoint = testEndpoint();
  let judgment: Awaited<ReturnType<typeof judge>>;
  try {
    judgment = await judge(
      view.state,
      activeKey,
      {
        ...cancellableJudgeTransport(),
        ...(endpoint ? { endpoint } : {}),
      },
      profile,
    );
  } catch (error) {
    if (settings.logRequests) {
      appendLog(sessionId, errorLogLine(loggedJudgeErrorKind(error), loggedBody));
    }
    saveSessionState(statePath, backoff(loadSessionState(statePath, Date.now()), Date.now()));
    saveDiagnostic(diagnosticPath(dataDir(env()), sessionId), loggedJudgeErrorKind(error));
    clearVerdict(verdict);
    return;
  }

  const fraction = usageFraction(usage);
  if (settings.logRequests) {
    appendLog(
      sessionId,
      responseLogLine(
        loggedBody ?? requestBody(view.state, profile),
        judgment,
        fraction,
        undefined,
        profile,
      ),
    );
  }
  clearDiagnostic(diagnosticPath(dataDir(env()), sessionId));
  // Another hook process (a compaction, a later Stop) may have written this session's record
  // or the settings while TypeSafe answered: judge against what is on disk now.
  const after = Date.now();
  let latest: Settings | undefined;
  try {
    latest = settingsOrThrow();
  } catch {}
  const current = loadSessionState(statePath, after);
  const resolution = resolve({
    fresh:
      latest !== undefined &&
      latest.profile === settings.profile &&
      tokens >= latest.minContextTokens &&
      cooldownReason(current, tokens, after) === undefined,
    qualifies: qualifies(judgment, fraction, profile),
    mode: latest?.mode ?? "off",
    autoAcknowledged: false,
  });
  state = { ...judged(current, resolution, tokens, fingerprint), updatedAt: after };
  saveSessionState(statePath, state);
  if (resolution !== "hint") {
    clearVerdict(verdict);
    return;
  }
  saveVerdict(verdict, {
    version: 1,
    sessionId,
    promptId: typeof payload.promptId === "string" ? payload.promptId : null,
    at: now,
    tokens: usage.tokens ?? null,
    score: score(judgment, profile),
    floor: floorFor(fraction, profile),
  });
}

// --- the other hooks ----------------------------------------------------------------

/** A new prompt retires the hint: the person moved on, whatever the status row still shows. */
function runPrompt(payload: HookPayload): void {
  const sessionId = sessionIdOf(payload);
  if (sessionId) clearVerdict(verdictPath(sessionId, env()));
}

/** Any compaction, Grok's own automatic one included, restarts the session's cooldown. */
function runCompact(payload: HookPayload): void {
  const sessionId = sessionIdOf(payload);
  if (!sessionId) return;
  clearVerdict(verdictPath(sessionId, env()));
  // PreCompact only retires the hint: the window has not moved yet. PostCompact is where the
  // session restarts, so the next judgment waits for fresh tokens and exchanges.
  if (payload.hook_event_name !== "PreCompact") {
    resetSessionState(sessionStatePath(sessionId, env()), Date.now());
  }
}

/**
 * Session start refreshes the launchers at the fixed path the person's `config.toml` points at
 * (the status-line script is not a plugin hook, so it is never told where the plugin lives) and
 * prunes records of sessions that ended long ago.
 */
function runSessionStart(): void {
  try {
    writeLaunchers();
  } catch {
    // Without the launchers the hint cannot be painted, but the turn is not ours to fail.
  }
  pruneStale();
}

const RESOLVE_INSTALLED_PLUGIN = [
  'const { existsSync } = require("node:fs");',
  'const { join } = require("node:path");',
  'const { execFileSync } = require("node:child_process");',
  "const home = process.env.COMPACT_ADVISER_GROK_HOME;",
  "function entry(root) {",
  '  if (typeof root !== "string" || !root) return "";',
  '  const path = join(root, "bin", "adviser.ts");',
  '  return existsSync(path) ? path : "";',
  "}",
  "try {",
  "  const list = JSON.parse(",
  '    execFileSync("grok", ["plugin", "list", "--json"], {',
  '      encoding: "utf8",',
  "      env: Object.assign({}, process.env, { GROK_HOME: home }),",
  "      timeout: 5000,",
  '      stdio: ["ignore", "pipe", "ignore"],',
  "    }),",
  "  );",
  '  const hit = (Array.isArray(list) ? list : []).find((p) => p && p.name === "compact-adviser");',
  "  const found = entry(hit && hit.path);",
  "  if (found) process.stdout.write(found);",
  "} catch {}",
].join("\n");

export function launcherBody(): string {
  return [
    "#!/bin/sh",
    "# Written by compact-adviser. Do not edit: `compact-adviser install` and every session start",
    "# rewrite it. It exists because the status-line script needs one fixed path, while the",
    "# package's own directory moves with every install. This script finds the current plugin.",
    'dir=$(dirname "$0")',
    'entry=""',
    'if [ -n "$GROK_PLUGIN_ROOT" ] && [ -f "$GROK_PLUGIN_ROOT/bin/adviser.ts" ]; then',
    '  entry="$GROK_PLUGIN_ROOT/bin/adviser.ts"',
    "fi",
    'if [ -z "$entry" ]; then',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    '  home="${GROK_HOME:-$HOME/.grok}"',
    '  case "$home" in',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    '    */) home="${home%/}" ;;',
    "  esac",
    '  entry=$(COMPACT_ADVISER_GROK_HOME="$home" node "$dir/resolve.cjs" </dev/null)',
    "fi",
    'if [ -z "$entry" ] || [ ! -f "$entry" ]; then',
    '  echo "compact-adviser: could not find the installed plugin" >&2',
    "  exit 1",
    "fi",
    'exec node "$entry" "$@"',
    "",
  ].join("\n");
}

export function statusLineLauncherBody(): string {
  return ["#!/bin/sh", 'exec "$(dirname "$0")/adviser.sh" status-line "$@"', ""].join("\n");
}

function writeLaunchers(): void {
  const dir = dataDir(env());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "resolve.cjs"), `${RESOLVE_INSTALLED_PLUGIN}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "adviser.sh"), launcherBody(), { mode: 0o700 });
  writeFileSync(join(dir, "status-line.sh"), statusLineLauncherBody(), { mode: 0o700 });
}

export function hookFilePath(env: Env = process.env): string {
  return join(grokHome(env), "hooks", "compact-adviser.json");
}

/**
 * The hook file, pointing at the stable launcher rather than this package copy. The plugin's
 * own hooks.json still uses GROK_PLUGIN_ROOT; this user-hook copy cannot, because Grok 1.0.34
 * never loads plugin hooks.
 */
export function hookFileBody(): string {
  const source = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "hooks", "hooks.json"), "utf8"),
  ) as {
    hooks: Record<
      string,
      Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>
    >;
  };
  const launcher = join(dataDir(env()), "adviser.sh");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: this is Grok's own expansion syntax
  const prefix = 'node "${GROK_PLUGIN_ROOT}/bin/adviser.ts"';
  for (const groups of Object.values(source.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        if (handler.command.startsWith(prefix)) {
          handler.command = `${shellQuote(launcher)}${handler.command.slice(prefix.length)}`;
        }
      }
    }
  }
  return `${JSON.stringify(source, null, 2)}\n`;
}

function install(): string {
  writeLaunchers();
  const path = hookFilePath(env());
  mkdirSync(join(grokHome(env()), "hooks"), { recursive: true });
  writeFileSync(path, hookFileBody(), { mode: 0o600 });
  return [
    `Registered the compact-adviser hooks at ${path}.`,
    "Hooks in your own Grok home are always trusted; restart Grok, or press r in the /hooks tab,",
    "to pick them up. Remove that file to uninstall them.",
    "",
    setupText(),
  ].join("\n");
}

function pruneStale(): void {
  const now = Date.now();
  for (const kind of ["sessions", "verdicts", "diagnostics"]) {
    const dir = join(dataDir(env()), kind);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > SESSION_RETENTION_MS) rmSync(path, { force: true });
      } catch {
        // A file that cannot be read is a file that cannot be pruned; leave it.
      }
    }
  }
}

// --- the status line ----------------------------------------------------------------

function runStatusLine(): void {
  const payload = parsePayload(readStdin());
  let enabled = true;
  try {
    enabled = settingsOrThrow().mode !== "off";
  } catch {
    // Unreadable settings paint the built-in segments alone rather than an error row.
    enabled = false;
  }
  const sessionId = payload.session_id;
  let hint = false;
  if (enabled && typeof sessionId === "string" && sessionId) {
    const verdict = loadVerdict(verdictPath(sessionId, env()));
    const usage = readPayloadUsage(payload);
    hint =
      verdict !== undefined && verdictApplies(verdict, Date.now(), payload.prompt_id, usage.tokens);
  }
  process.stdout.write(statusLine(payload, hint, process.env.NO_COLOR === undefined));
}

// --- the person-facing commands -----------------------------------------------------

function statusText(): string {
  const settings = settingsOrThrow();
  const home = grokHome(env());
  const key = resolveKey(settings, process.cwd());
  const lines = [
    `Mode: ${settings.mode} (Grok is hint-only; nothing outside a session can run /compact).`,
    `Minimum context: ${formatTokens(settings.minContextTokens)} tokens.`,
    `${formatKeyStatus(key.source)}.`,
    `Request log: ${settings.logRequests ? requestLogPath(dataDir(env()), "<session-id>") : "off"}.`,
    `Settings file: ${settingsPath(env())}.`,
    `Grok home: ${home}.`,
  ];
  const sessionId = process.env.GROK_SESSION_ID;
  if (sessionId) {
    const state = loadSessionState(sessionStatePath(sessionId, env()), Date.now());
    const dir = findSessionDir(process.cwd(), sessionId, env());
    const usage = readSignalsUsage(dir);
    const fraction = usageFraction(usage);
    lines.push(
      `Session ${sessionId}: ${state.completed} completed exchange(s) since the last compaction.`,
      `Context: ${usage.tokens === undefined ? "unknown" : formatTokens(usage.tokens)}${
        Number.isFinite(fraction)
          ? ` (${Math.round(fraction * 100)}% of the window; hint floor ${floorFor(fraction, parseProfile(settings.profile)).toFixed(2)})`
          : ` (usage unknown; hint floor ${floorFor(Number.NaN, parseProfile(settings.profile)).toFixed(2)})`
      }.`,
      `Cooldown: ${
        usage.tokens === undefined
          ? "unknown until Grok records this session's token usage."
          : (cooldownReason(state, usage.tokens, Date.now()) ??
            "none; semantic checks still apply.")
      }`,
    );
    const diagnostic = loadDiagnostic(diagnosticPath(dataDir(env()), sessionId));
    if (diagnostic) lines.push(`Last TypeSafe outcome: ${diagnostic}.`);
  }
  return lines.join("\n");
}

function setupText(): string {
  return `Add this to your own ${join(grokHome(env()), "config.toml")}, then restart Grok:

[ui.status_line]
type = "command"
command = ${JSON.stringify(shellQuote(join(dataDir(env()), "status-line.sh")))}

The status row is off by default and only your own config can turn it on: installing a plugin
cannot set it, and a repository cannot either. Grok has one status row, so this script paints
the built-in segments too (${STATUS_LINE_ITEMS.join(", ")}). There is no status row at
all in minimal render mode.`;
}

function snooze(): string {
  const sessionId = process.env.GROK_SESSION_ID;
  if (!sessionId) return "No session id in the environment; run this from inside a Grok session.";
  const path = sessionStatePath(sessionId, env());
  const state = loadSessionState(path, Date.now());
  saveSessionState(path, {
    ...state,
    snoozeUntil: state.completed + 4,
    updatedAt: Date.now(),
  });
  clearVerdict(verdictPath(sessionId, env()));
  return "Advice snoozed for three completed exchanges.";
}

function dismiss(): string {
  const sessionId = process.env.GROK_SESSION_ID;
  if (!sessionId) return "No session id in the environment; run this from inside a Grok session.";
  clearVerdict(verdictPath(sessionId, env()));
  return "Hint dismissed.";
}

function runCommand(argv: readonly string[]): string {
  const [command = "", ...rest] = argv;
  const value = rest.join(" ").trim();
  switch (command) {
    case "status":
      return statusText();
    case "mode":
      return `Mode saved: ${updateSettings({ mode: parseMode(value) }).mode}.`;
    case "threshold": {
      const count = value === "default" ? DEFAULT_MINIMUM : parseMinimum(value);
      return `Minimum context saved: ${formatTokens(updateSettings({ minContextTokens: count }).minContextTokens)} tokens.`;
    }
    case "key":
      if (value === "clear") {
        updateSettings({ typesafeApiKey: "" });
        return "Saved TypeSafe API key cleared. TYPESAFE_API_KEY and a cwd .env still apply.";
      }
      updateSettings({ typesafeApiKey: parseSavedApiKey(value) });
      return "TypeSafe API key saved. Status shows the source, never the value.";
    case "log": {
      if (value !== "on" && value !== "off") throw new SettingsError("Choose on or off.");
      updateSettings({ logRequests: value === "on" });
      return `TypeSafe request logging ${value}.`;
    }
    case "snooze":
      return snooze();
    case "dismiss":
      return dismiss();
    case "install":
      return install();
    case "":
    case "help":
    case "--help":
    case "-h":
      return USAGE;
    default:
      throw new SettingsError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

// --- entry point --------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<void> {
  const [command = "", ...rest] = argv;
  if (disabledByEnv(process.env[DISABLE_ENV])) {
    if (command === "hook") process.exit(0);
    if (command === "status-line") {
      try {
        process.stdout.write(
          statusLine(parsePayload(readStdin()), false, process.env.NO_COLOR === undefined),
        );
      } catch {
        // A broken row is worse than no row; print nothing and let Grok keep the last one.
      }
      process.exit(0);
    }
    fail("COMPACT_ADVISER_DISABLE is set; compact-adviser is taking no action.");
  }
  if (command === "hook") {
    // Every hook path is fail-open and silent: the turn must not notice this process at all.
    try {
      const payload = hookPayload();
      const event = rest[0] ?? "";
      if (event === "stop") await runStop(payload);
      else if (event === "prompt") runPrompt(payload);
      else if (event === "compact") runCompact(payload);
      else if (event === "session-start") runSessionStart();
      else if (event === "session-end") pruneStale();
    } catch {
      // Recorded nowhere on purpose: a hook failure is Grok's scrollback noise, not advice.
    }
    process.exit(0);
  }
  if (command === "status-line") {
    try {
      runStatusLine();
    } catch {
      // A broken row is worse than no row; print nothing and let Grok keep the last one.
    }
    process.exit(0);
  }
  try {
    out(runCommand([command, ...rest]));
  } catch (error) {
    fail(error instanceof Error ? error.message : "Could not run that command.");
  }
}

await main(process.argv.slice(2));
