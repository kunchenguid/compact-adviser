// compact-adviser for Claude Code: the hooks module of the `compact-adviser` mod.
//
// A Claude Code "mod" is a plugin whose behavior lives in one hooks module. Claude Code
// may load it through its rollout flag or CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, but every
// handler requires that variable to equal `1`, so rollout-only loading is a no-op.
//
// This is the only file that touches the engine interface `$`. The decisions live in
// ../lib (settings, cooldowns, the bounded judge input, and the Jev client), which the
// suites under ../tests exercise through `claude plugin test`. ../README.md owns the
// user-facing contract and ../../../docs/product-contract.md the shared semantics.
//
// Two engine facts shape this file:
// - Saving a `userConfig` row through `$.config.set` hot-reloads this module and raises
//   `session.start` again, so module variables are per-reload scratch and every fact a
//   cooldown depends on lives in `$.store`.
// - `$.session.compact` runs through every hook but the caller's, so this module's own
//   `session.compact` hook never sees its own automatic compaction; that path resets the
//   session's counters itself.
import type { EngineInterface, PluginOptions, Register, RenderChildren } from "claude-code";
import {
  API_KEY_KEY,
  CONSENT_STORE_KEY,
  type Config,
  type Consent,
  DEFAULT_MINIMUM,
  formatTokens,
  LOG_KEY,
  MINIMUM_KEY,
  MODE_KEY,
  type Mode,
  parseConsent,
  parseMinimum,
  parseSavedApiKey,
  readConfig,
  readSavedApiKey,
} from "../lib/config.ts";
import { disabledByEnv } from "../lib/disable.ts";
import {
  formatKeyStatus,
  parseDotenvKey,
  resolveTypesafeApiKey,
  type TypesafeKeySource,
} from "../lib/env.ts";
import {
  floorFor,
  JUDGE_DISABLED_NETWORK_MESSAGE,
  JUDGE_UNAVAILABLE_MESSAGE,
  JudgeError,
  judge,
  qualifies,
  requestBody,
} from "../lib/judge.ts";
import {
  errorLogLine,
  loggedJudgeErrorKind,
  requestLogLine,
  requestLogPath,
  responseLogLine,
} from "../lib/log.ts";
import { parseProfile } from "../lib/profile.ts";
import { snapshot } from "../lib/snapshot.ts";
import {
  backoff,
  completeExchange,
  cooldownReason,
  initialState,
  restoreState,
  type SessionState,
  sessionKey,
  staleSessionKeys,
} from "../lib/state.ts";

const COMMAND = "compact-adviser";
const PANE_ID = "compact-adviser";
const HINT = "work appears completed or recorded. Run /compact to save tokens.";
const COMPACT_INSTRUCTIONS =
  "The session reached a natural boundary; keep the current work, pending tasks, referenced files, and the next step exact.";
const PENDING_NOTICE_KEY = "pendingNotice";
const LOOPBACK_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[\x21-\x7e]*$/;
const USAGE =
  "Use /compact-adviser, auto, hint, off, status, threshold <tokens|default>, snooze or dismiss.";

// Per module environment (a hot reload starts fresh; see the header).
let activation: Promise<boolean> | undefined;
// The host-validated options this environment loaded with (a save reloads it with new ones).
let loadedOptions: PluginOptions = {};
let interactive = false;
let generation = 0;
let judging = false;
let compacting = false;
let hintVisible = false;
let diagnostic = "";
// What the latest settled turn end came to, for `/compact-adviser status` only.
let lastCheck: string | undefined;
// Why request logging stopped in this environment; set once a log exists but cannot be read.
let logProblem: string | undefined;
// The settings pane: one list of rows, as the Pi extension's menu, each opening a view
// of its own; Enter on an option or a saved value returns to the list. A save hot-reloads
// the module, so this scratch resets to the list on its own.
type PaneView = "menu" | "mode" | "minimum" | "logging" | "key";
let view: PaneView = "menu";
// The list row the person last opened; the ring returns there.
let menuRow = "menu:mode";
// Where the ring should land once the next drawing is up: the engine keeps a moved ring
// at its position, so a view change places it itself.
let pendingFocus: string | undefined;
let minimumDraft: { text: string; error?: string } | undefined;
let keyDraft: { text: string; error?: string } | undefined;
let statusDetails: string | undefined;

/**
 * Both environment gates, resolved once per module environment and cached: function
 * hooks must be on, and `COMPACT_ADVISER_DISABLE` must not be set to a truthy value.
 * Every hook goes through here, so a disabled session registers no command, shows no
 * status, and never reaches TypeSafe.
 */
function isActivated($: EngineInterface): Promise<boolean> {
  if (activation === undefined) {
    activation = Promise.all([
      $.env.get("CLAUDE_CODE_ENABLE_FUNCTION_HOOKS").then(
        (value) => value === "1",
        () => false,
      ),
      // `$.env.get` takes a literal name, so `DISABLE_ENV` cannot be spelled here.
      $.env.get("COMPACT_ADVISER_DISABLE").then(disabledByEnv, () => false),
    ]).then(([hooks, disabled]) => hooks && !disabled);
  }
  return activation;
}

async function resolvedKey($: EngineInterface) {
  const fromEnv = await $.env.get("TYPESAFE_API_KEY");
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return resolveTypesafeApiKey(fromEnv);
  }
  const saved = readSavedApiKey(await $.config.list(), loadedOptions);
  if (saved) return resolveTypesafeApiKey(undefined, saved);
  let dotenv: string | undefined;
  try {
    dotenv = parseDotenvKey(await $.fs.read(".env"), "TYPESAFE_API_KEY");
  } catch {
    dotenv = undefined;
  }
  return resolveTypesafeApiKey(undefined, undefined, dotenv);
}

async function apiKey($: EngineInterface): Promise<string> {
  return (await resolvedKey($)).value?.trim() ?? "";
}

/** A loopback-only endpoint override for the live regression's local TypeSafe fixture. */
async function testEndpoint($: EngineInterface): Promise<string | undefined> {
  const value = await $.env.get("COMPACT_ADVISER_TEST_ENDPOINT");
  return value !== undefined && LOOPBACK_ENDPOINT.test(value) ? value : undefined;
}

async function loadConfig($: EngineInterface): Promise<Config> {
  return readConfig(await $.config.list(), await $.store.get(CONSENT_STORE_KEY), loadedOptions);
}

async function loadConsent($: EngineInterface): Promise<Consent> {
  return parseConsent(await $.store.get(CONSENT_STORE_KEY));
}

async function loadState($: EngineInterface): Promise<{ key: string; state: SessionState }> {
  const key = sessionKey(await $.session.id());
  return { key, state: restoreState(await $.store.get(key), await $.clock.now()) };
}

async function checkpointKey(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function judgeFailureMessage(error: unknown): string {
  // Claude Code refuses plugin network access outright under
  // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC; say so instead of a generic network error.
  if (String((error as { cause?: unknown })?.cause).includes("nonessential network traffic")) {
    return JUDGE_DISABLED_NETWORK_MESSAGE;
  }
  return error instanceof JudgeError ? error.message : JUDGE_UNAVAILABLE_MESSAGE;
}

/**
 * This session's request log, or undefined without HOME: request bodies carry transcript
 * text, so they are never written into the working directory instead.
 */
async function sessionLogPath($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get("HOME");
  if (home === undefined || home.trim() === "") return undefined;
  return requestLogPath(home, await $.session.id());
}

/**
 * `$.fs.write` replaces the whole file, so an append is read-then-write. A log that exists
 * but cannot be read (the host refuses reads over 4 MiB) is left untouched and logging
 * pauses, rather than the rewrite replacing it with one line.
 */
async function appendTypeSafeLog($: EngineInterface, line: string): Promise<void> {
  if (logProblem !== undefined) return;
  const path = await sessionLogPath($);
  if (path === undefined) return;
  let existing = "";
  if (await $.fs.exists(path)) {
    try {
      existing = await $.fs.read(path);
    } catch {
      logProblem = "paused; the existing log could not be read, so it was left untouched";
      return;
    }
  }
  await $.fs.write(path, `${existing}${line}`);
}

async function requestLogStatus($: EngineInterface, config: Config): Promise<string> {
  if (!config.logRequests) return "off";
  return logProblem ?? (await sessionLogPath($)) ?? "unavailable, HOME is not set";
}

function notice($: EngineInterface, message: string): void {
  if (diagnostic === message) return;
  diagnostic = message;
  $.ui.toast(message, { timeoutMs: 8000 });
}

function clearStatus($: EngineInterface): void {
  if (interactive) $.ui.status(undefined);
}

async function invalidate($: EngineInterface): Promise<void> {
  generation++;
  if (hintVisible) {
    hintVisible = false;
    clearStatus($);
  }
}

/** Context tokens over the active limit, or NaN when the engine does not know it (strictest floor). */
function usageFraction(context: {
  tokens?: number;
  window: number;
  breakdown?: { isAutoCompactEnabled: boolean; autoCompactThreshold?: number };
}): number {
  const threshold = context.breakdown?.autoCompactThreshold;
  const denominator =
    context.breakdown?.isAutoCompactEnabled &&
    typeof threshold === "number" &&
    Number.isFinite(threshold) &&
    threshold > 0
      ? threshold
      : context.window;
  if (
    typeof context.tokens !== "number" ||
    !Number.isFinite(context.tokens) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  )
    return Number.NaN;
  return context.tokens / denominator;
}

/** Why this checkpoint may not be judged, cheapest gate first; undefined when it may. */
async function ineligibility(
  $: EngineInterface,
  config: Config,
  state: SessionState,
  tokens: number | undefined,
  now: number,
): Promise<string | undefined> {
  if (!interactive) return "the session is not interactive";
  if (compacting) return "a compaction is running";
  if (config.mode === "off") return "mode is off";
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return "context size unknown";
  if (tokens < config.minContextTokens) return "context below the minimum";
  const cooldown = cooldownReason(state, tokens, now);
  if (cooldown !== undefined) return `cooldown: ${cooldown}`;
  if ((await apiKey($)) === "") return "no TypeSafe key";
  return undefined;
}

/** The scheduled half of a turn end: judge, then hint or (opt-in) compact. */
async function judgeCheckpoint($: EngineInterface, epoch: number): Promise<void> {
  if (epoch !== generation || judging || compacting) return;
  judging = true;
  try {
    const initial = await loadConfig($);
    const profile = parseProfile(initial.profile);
    const [messages, activeKey, rows] = await Promise.all([
      $.session.messages(),
      apiKey($),
      $.config.list(),
    ]);
    const view = snapshot(messages, [activeKey, readSavedApiKey(rows, loadedOptions)]);
    if (view.conversationTokens <= 20000) {
      lastCheck = "not checked, too little conversation history";
      return;
    }
    const fingerprint = await checkpointKey(view.checkpointText);
    if ((await loadState($)).state.lastHintKey === fingerprint) {
      lastCheck = "not checked, already advised at this checkpoint";
      return;
    }
    let loggedBody: string | undefined;
    if (initial.logRequests) {
      try {
        loggedBody = requestBody(view.state, profile);
        await appendTypeSafeLog($, requestLogLine(loggedBody));
      } catch {
        // Request logging must not replace or delay the judgment.
      }
    }
    const endpoint = await testEndpoint($);
    let result: Awaited<ReturnType<typeof judge>>;
    try {
      result = await judge(
        view.state,
        await apiKey($),
        {
          fetch: (url, init) => $.http.fetch(url, init),
          sleep: (ms) => $.clock.sleep(ms),
          ...(endpoint ? { endpoint } : {}),
        },
        profile,
      );
    } catch (error) {
      if (epoch !== generation) {
        lastCheck = "judgment discarded, a new turn started";
        return;
      }
      lastCheck = "the judgment failed; context left unchanged";
      if (initial.logRequests) {
        try {
          await appendTypeSafeLog($, errorLogLine(loggedJudgeErrorKind(error), loggedBody));
        } catch {
          // Error logging must not replace backoff.
        }
      }
      const { key, state } = await loadState($);
      await $.store.set(key, backoff(state, await $.clock.now()));
      notice($, judgeFailureMessage(error));
      return;
    }
    if (epoch !== generation) {
      lastCheck = "judgment discarded, a new turn started";
      return;
    }
    const latest = await loadConfig($);
    const { key, state: current } = await loadState($);
    const now = await $.clock.now();
    const { context } = await $.session.usage({ breakdown: "summary" });
    if (initial.logRequests) {
      try {
        await appendTypeSafeLog(
          $,
          responseLogLine(
            loggedBody ?? requestBody(view.state, profile),
            result,
            usageFraction(context),
            undefined,
            profile,
          ),
        );
      } catch {
        // Response logging must not replace the gate decision.
      }
    }
    // The epoch check sits right before the write: a turn that completed during the awaits
    // above has stored a newer record, which `current` must not overwrite.
    if (
      JSON.stringify(latest) !== JSON.stringify(initial) ||
      (await ineligibility($, latest, current, context.tokens, now)) !== undefined ||
      epoch !== generation
    ) {
      lastCheck = "judgment discarded, settings or session changed meanwhile";
      return;
    }
    let state: SessionState = { ...current, failures: 0, retryAfter: 0, updatedAt: now };
    const auto = latest.mode === "auto";
    if (!qualifies(result, usageFraction(context), profile)) {
      lastCheck = "judged, not a checkpoint yet";
      await $.store.set(key, state);
      return;
    }
    if (auto && !latest.autoAcknowledged) {
      lastCheck = "judged a checkpoint; automatic mode is not confirmed (/compact-adviser auto)";
      await $.store.set(key, state);
      return;
    }
    diagnostic = "";
    if (!auto) {
      state = { ...state, lastHintAt: state.completed, lastHintKey: fingerprint };
      await $.store.set(key, state);
      if (epoch !== generation) return;
      lastCheck = "judged a checkpoint; hint shown";
      hintVisible = true;
      // Claude Code prefixes $.ui.status with the plugin name; do not repeat it.
      $.ui.status(HINT);
      return;
    }
    await $.store.set(key, state);
    // No await between this last identity check and the compaction request.
    if (epoch !== generation || compacting) return;
    compacting = true;
    // A status line, not a toast: the host drops a toast within two seconds of the last,
    // which would swallow the completion notice of a quick compaction.
    $.ui.status("compacting at a checkpoint (experimental auto)…");
    let failure: string | undefined;
    let tokens: { before?: number; after?: number } = {};
    try {
      const compacted = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS });
      if (compacted.skip !== undefined) failure = compacted.skip;
      else tokens = { before: compacted.tokensBefore, after: compacted.tokensAfter };
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      compacting = false;
    }
    const after = await $.clock.now();
    if (failure !== undefined && epoch !== generation) {
      // The host refuses a compaction once a turn runs: stale work, not a failure to report.
      lastCheck = "judged a checkpoint; compaction dropped, a new turn started";
      clearStatus($);
      return;
    }
    if (failure !== undefined) {
      lastCheck = "judged a checkpoint; compaction failed";
      const { state: latestState } = await loadState($);
      await $.store.set(key, { ...latestState, retryAfter: after + 60000, updatedAt: after });
      notice(
        $,
        "Compaction failed or was cancelled. No immediate retry; Claude Code remains in control.",
      );
      clearStatus($);
      return;
    }
    generation++;
    lastCheck = "judged a checkpoint; compacted";
    await $.store.set(key, initialState(true, after));
    const completed =
      tokens.before !== undefined && tokens.after !== undefined
        ? `compaction completed: ${formatTokens(tokens.before)} to ${formatTokens(tokens.after)} tokens.`
        : "compaction completed.";
    // The dim transcript line (never sent to the model) records the automatic action even
    // when the host throttles the toast. Claude Code prefixes $.ui.log with the plugin name.
    $.ui.log(`automatic ${completed}`);
    $.ui.toast(completed);
    clearStatus($);
  } finally {
    judging = false;
  }
}

/** The synchronous half of a turn end: count the exchange and run the cheap gates. */
async function settle($: EngineInterface): Promise<void> {
  const { context } = await $.session.usage();
  const now = await $.clock.now();
  const { key, state: stored } = await loadState($);
  const state = completeExchange(stored, context.tokens, now);
  await $.store.set(key, state);
  let config: Config;
  try {
    config = await loadConfig($);
  } catch (error) {
    lastCheck = "not checked, settings unreadable";
    notice($, error instanceof Error ? error.message : "Cannot read compact-adviser settings.");
    return;
  }
  const skip = judging
    ? "a judgment is already running"
    : await ineligibility($, config, state, context.tokens, now);
  if (skip !== undefined) {
    lastCheck = `not checked, ${skip}`;
    return;
  }
  const epoch = generation;
  $.clock.after(0, () => {
    void judgeCheckpoint($, epoch).catch(() =>
      notice($, "Compact adviser could not inspect this checkpoint; context left unchanged."),
    );
  });
}

async function saveRow(
  $: EngineInterface,
  key: string,
  value: string | number | boolean,
  message: string,
): Promise<boolean> {
  await invalidate($);
  // A saved row hot-reloads this module, which drops this environment's later toasts, so
  // the confirmation is left for the reloaded environment to show at its session.start.
  await $.store.set(PENDING_NOTICE_KEY, { message, at: await $.clock.now(), row: menuRow });
  const result = await $.config.set({ key, value });
  if (result.deny !== undefined) {
    await $.store.delete(PENDING_NOTICE_KEY);
    $.ui.toast(`Not saved: ${result.deny}`, { timeoutMs: 8000 });
    return false;
  }
  if (key === API_KEY_KEY && typeof value === "string") {
    loadedOptions = { ...loadedOptions, typesafeApiKey: value };
  }
  diagnostic = "";
  await showPendingNotice($);
  return true;
}

/**
 * Shows and clears a save confirmation, whichever environment gets to it first, and puts
 * the pane's ring back on the row that saved: the reloaded environment starts with the
 * list and an unplaced ring.
 */
async function showPendingNotice($: EngineInterface): Promise<void> {
  const pending = (await $.store.get(PENDING_NOTICE_KEY)) as {
    message?: unknown;
    at?: unknown;
    row?: unknown;
  };
  if (pending === undefined) return;
  await $.store.delete(PENDING_NOTICE_KEY);
  const fresh = typeof pending.at === "number" && (await $.clock.now()) - pending.at < 30000;
  if (fresh && typeof pending.message === "string") {
    $.ui.toast(pending.message, { timeoutMs: 6000 });
  }
  if (fresh && typeof pending.row === "string" && (await paneOpen($))) {
    showMenu(pending.row);
    // A confirmation dialog on the way may have handed the keys to the prompt; ask again.
    await openPane($).catch(() => undefined);
    await placeRing($, 40);
  }
}

async function paneOpen($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some((pane) => pane.id === PANE_ID);
  } catch {
    return false;
  }
}

async function saveConsent($: EngineInterface, patch: Partial<Omit<Consent, "version">>) {
  await invalidate($);
  await $.store.set(CONSENT_STORE_KEY, { ...(await loadConsent($)), ...patch });
  diagnostic = "";
}

async function openPane($: EngineInterface): Promise<void> {
  // A pane the person asked for is placed at any width, so the placement result is unused.
  await $.ui.open({
    id: PANE_ID,
    title: "Compact adviser (saved for all sessions)",
    focus: true,
    closeOnEscape: true,
    rows: 12,
  });
}

function showMenu(row?: string): void {
  view = "menu";
  if (row !== undefined) menuRow = row;
  pendingFocus = menuRow;
  minimumDraft = undefined;
  keyDraft = undefined;
}

function openView(target: Exclude<PaneView, "menu">, row: string, focus: string): void {
  view = target;
  menuRow = row;
  pendingFocus = focus;
  minimumDraft = undefined;
  keyDraft = undefined;
}

/** Lands the ring where the last view change asked, once that drawing is up. */
async function placeRing($: EngineInterface, attempts = 10): Promise<void> {
  const key = pendingFocus;
  if (key === undefined) return;
  pendingFocus = undefined;
  // Every view keys its elements apart, so the call is refused until the new drawing is up.
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await $.ui.focus({ requestId: PANE_ID, key });
      if (result.deny === undefined) return;
    } catch {
      return;
    }
    await $.clock.sleep(50);
  }
}

const MODE_LABELS: Record<Mode, string> = {
  hint: "Hints only (default)",
  auto: "Automatic (experimental)",
  off: "Off",
};

/** What the list row says about the key in effect: its source, never its value. */
const KEY_SOURCE_LABELS: Record<TypesafeKeySource, string> = {
  env: "from the environment",
  saved: "saved",
  ".env": "from .env",
  missing: "missing",
};

/** The key view's explanation: which key is in effect, and what the actions here change. */
function keyDetail(source: TypesafeKeySource, saved: boolean): string {
  switch (source) {
    case "env":
      return saved
        ? "In effect: TYPESAFE_API_KEY from the launch environment, which wins over the key saved here."
        : "In effect: TYPESAFE_API_KEY from the launch environment.";
    case "saved":
      return "In effect: the key saved here, for all sessions.";
    case ".env":
      return "In effect: TYPESAFE_API_KEY from the .env file in the working directory.";
    default:
      return "No key in effect. Save one here, or set TYPESAFE_API_KEY in the environment or a .env file.";
  }
}

/**
 * Asks in the engine's dialog. The dialog takes the keyboard from an open settings pane
 * and hands it to the prompt when it closes, so a pane that asked requests it back.
 */
async function confirm(
  $: EngineInterface,
  question: string,
  yes: string,
  header: string,
  fromPane: boolean,
) {
  try {
    return (await $.ui.ask(question, { options: [yes, "Cancel"], header })) === yes;
  } catch {
    return false;
  } finally {
    if (fromPane) await openPane($).catch(() => undefined);
  }
}

async function changeMode($: EngineInterface, mode: Mode, fromPane = false): Promise<void> {
  if (mode === "auto") {
    if (!(await loadConsent($)).autoAcknowledged) {
      const confirmed = await confirm(
        $,
        "Automatic mode persists across all Claude Code sessions and projects. Compaction is lossy and timing accuracy is not proven. It only acts at eligible checkpoints; it does not compact immediately. Enable experimental automatic compaction?",
        "Enable automatic mode",
        "Auto mode",
        fromPane,
      );
      if (!confirmed) return;
      await saveConsent($, { autoAcknowledged: true });
    }
    await saveRow(
      $,
      MODE_KEY,
      "auto",
      "Automatic mode saved (all sessions). A TypeSafe key is still required.",
    );
    return;
  }
  await saveRow(
    $,
    MODE_KEY,
    mode,
    `${mode === "hint" ? "Hints only" : "Off"} saved (all sessions). Claude Code's built-in compaction is unchanged.`,
  );
}

/** Validates and saves a minimum; throws the validation message for the caller to show. */
async function changeMinimum($: EngineInterface, text: string): Promise<boolean> {
  const count = text === "default" ? DEFAULT_MINIMUM : parseMinimum(text);
  const { context } = await $.session.usage();
  const warning =
    count >= context.window
      ? ` Warning: this is at or above the active model's ${formatTokens(context.window)}-token window, so advice will not trigger before Claude Code's own compaction.`
      : "";
  return saveRow(
    $,
    MINIMUM_KEY,
    count,
    `Minimum context saved: ${formatTokens(count)} tokens (all sessions).${warning}`,
  );
}

async function changeLogRequests($: EngineInterface, enabled: boolean): Promise<void> {
  await saveRow(
    $,
    LOG_KEY,
    enabled,
    enabled
      ? `TypeSafe request logging on (all sessions). ${(await sessionLogPath($)) ?? "HOME is not set, so nothing is written."}`
      : "TypeSafe request logging off (all sessions).",
  );
}

async function changeSavedApiKey($: EngineInterface, text: string): Promise<boolean> {
  return saveRow(
    $,
    API_KEY_KEY,
    parseSavedApiKey(text),
    "TypeSafe API key saved (all sessions). Status shows the source, never the value.",
  );
}

async function clearSavedApiKey($: EngineInterface): Promise<boolean> {
  return saveRow(
    $,
    API_KEY_KEY,
    "",
    "Saved TypeSafe API key cleared (all sessions). Launch environment and .env still apply.",
  );
}

async function statusText($: EngineInterface): Promise<string> {
  const config = await loadConfig($);
  const { state } = await loadState($);
  const usage = await $.session.usage({ breakdown: "summary" });
  const tokens = usage.context.tokens;
  const breakdown = usage.context.breakdown;
  const engine =
    breakdown === undefined
      ? ""
      : breakdown.isAutoCompactEnabled && breakdown.autoCompactThreshold !== undefined
        ? ` Claude Code auto-compacts at ${formatTokens(breakdown.autoCompactThreshold)} tokens.`
        : " Claude Code auto-compact is off.";
  const cooldown =
    typeof tokens === "number"
      ? (cooldownReason(state, tokens, await $.clock.now()) ??
        "No cooldown; semantic checks still apply.")
      : "Waiting for fresh model usage.";
  return `Mode: ${config.mode}${config.mode === "auto" && !config.autoAcknowledged ? " (not confirmed)" : ""}. Minimum: ${formatTokens(config.minContextTokens)} tokens. Context: ${typeof tokens === "number" ? formatTokens(tokens) : "unknown"}${Number.isFinite(usageFraction(usage.context)) ? ` (${Math.round(usageFraction(usage.context) * 100)}% of the context limit; hint floor ${floorFor(usageFraction(usage.context), parseProfile(config.profile)).toFixed(2)})` : ""}. ${formatKeyStatus((await resolvedKey($)).source)}. ${cooldown}${lastCheck === undefined ? "" : ` Last turn end: ${lastCheck}.`}${engine} Request log: ${await requestLogStatus($, config)}. Settings: /config (compact-adviser rows) and /compact-adviser.`;
}

async function snoozeOrDismiss($: EngineInterface, command: "snooze" | "dismiss") {
  const { key, state } = await loadState($);
  await invalidate($);
  if (command === "snooze") {
    await $.store.set(key, {
      ...state,
      snoozeUntil: state.completed + 4,
      updatedAt: await $.clock.now(),
    });
  }
  $.ui.toast(
    command === "snooze" ? "Advice snoozed for three completed exchanges." : "Hint dismissed.",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not save settings.";
}

export const register: Register = (on, options) => {
  loadedOptions = options;
  on("session.start", async ($, e, next) => {
    if (!(await isActivated($))) return next(e);
    interactive = e.isInteractive;
    if (!interactive) return next(e);
    generation++;
    judging = false;
    compacting = false;
    hintVisible = false;
    lastCheck = undefined;
    logProblem = undefined;
    await $.command.register({
      name: COMMAND,
      description: "Configure persistent compaction advice, experimental auto, and token minimum",
      argumentHint: "[auto|hint|off|status|threshold <tokens|default>|snooze|dismiss]",
    });
    try {
      const now = await $.clock.now();
      const keys = (await $.store.keys()).filter((key) => key.startsWith("session:"));
      const entries = await Promise.all(
        keys.map(async (key) => ({ key, value: await $.store.get(key) })),
      );
      for (const key of staleSessionKeys(entries, now)) await $.store.delete(key);
    } catch {
      // Pruning is housekeeping; a failure leaves old cooldown records in place.
    }
    await showPendingNotice($).catch(() => undefined);
    clearStatus($);
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    if (await isActivated($)) await invalidate($);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (!(await isActivated($)) || !interactive) return result;
    if (e.agentId !== undefined) return result;
    if (e.reason !== "answer" || e.isAborted || !e.answer.trim()) {
      lastCheck = e.isAborted
        ? "not checked, the turn was interrupted"
        : "not checked, the turn ended without an answer";
      return result;
    }
    try {
      await settle($);
    } catch {
      notice($, "Compact adviser could not inspect this checkpoint; context left unchanged.");
    }
    return result;
  });

  // Any compaction but this module's own (which never reaches its own hook) resets the
  // session's cooldown; a precompute installs nothing and a subagent's is its own.
  on("session.compact", async ($, e, next) => {
    const result = await next(e);
    if (!(await isActivated($)) || !interactive) return result;
    if (e.trigger === "precompute" || e.agentId !== undefined || result.skip !== undefined) {
      return result;
    }
    try {
      await invalidate($);
      const key = sessionKey(await $.session.id());
      await $.store.set(key, initialState(true, await $.clock.now()));
    } catch {
      // The cooldown record stays as it was; the next judgment re-reads fresh usage.
    }
    return result;
  });

  on("command.run", { command: COMMAND }, async ($, e, next) => {
    if (!(await isActivated($))) return next(e);
    if (!interactive) return { text: "compact-adviser acts only in interactive sessions." };
    const [command = "", ...rest] = e.args.trim().split(/\s+/);
    const value = rest.join(" ");
    try {
      if (!command) {
        showMenu("menu:mode");
        statusDetails = undefined;
        await openPane($);
        await placeRing($, 40);
      } else if (["auto", "hint", "off"].includes(command) && !value) {
        await changeMode($, command as Mode);
      } else if (command === "threshold" && value) {
        await changeMinimum($, value);
      } else if (command === "status" && !value) {
        // Claude Code prefixes $.ui.log with the plugin name; do not repeat it.
        $.ui.log(await statusText($));
      } else if ((command === "snooze" || command === "dismiss") && !value) {
        await snoozeOrDismiss($, command);
      } else {
        throw new Error(USAGE);
      }
    } catch (error) {
      $.ui.toast(errorMessage(error), { timeoutMs: 8000 });
    }
    return {};
  });

  // Keep the saved key out of `/config` so the host menu never draws the secret.
  // Hidden rows still persist through $.config.set in the same settings path as mode.
  on("config.describe", { key: "compact-adviser.typesafeApiKey" }, async (_$, e, next) => {
    const described = await next(e);
    return { ...described, isHidden: true };
  });

  // Escape in a view returns to the list, as Pi's select cancels back to its menu; at
  // the list it closes the pane as the person asked.
  on("ui.close", { id: PANE_ID }, async ($, e, next) => {
    if (!(await isActivated($)) || e.origin.kind !== "person" || view === "menu") return next(e);
    showMenu();
    await $.ui.invalidate("ui.render");
    // Escape hands the keys to the prompt as it asks to close; ask for them back.
    await openPane($).catch(() => undefined);
    await placeRing($);
    return { value: undefined };
  });

  // The settings pane: the Pi extension's menu as engine elements. One list of rows the
  // arrows move through (a plain Button each, so no picker swallows the keys); Enter
  // opens a row's own view, where an option, a field, or Back returns to the list.
  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (!(await isActivated($)) || e.requestId !== PANE_ID) return next(e);
    if (e.surface !== "terminal") {
      const { Text } = $.ui.resolve(e);
      return Text({ children: USAGE });
    }
    const { Box, Text, Input, Button } = $.ui.resolve(e);
    const column = (children: RenderChildren[]) => Box({ flexDirection: "column", children });
    const heading = (crumb?: string) =>
      Box({
        flexDirection: "row",
        marginBottom: 1,
        children: [
          Text({ bold: true, children: "Compact adviser" }),
          Text({ dimColor: true, children: crumb ? ` › ${crumb}` : "  saved for all sessions" }),
        ],
      });
    const hint = (leave: string) =>
      Text({ dimColor: true, children: `↑↓ move · Enter select · Esc ${leave}` });
    const closePane = () => void $.ui.close({ id: PANE_ID });
    const redraw = async () => {
      await $.ui.invalidate("ui.render");
      await placeRing($);
    };
    const run = (action: () => Promise<unknown>) => {
      void action()
        .catch((error) => $.ui.toast(errorMessage(error), { timeoutMs: 8000 }))
        .finally(redraw);
    };
    const back = () => {
      showMenu();
      void redraw();
    };
    let config: Config;
    try {
      config = await loadConfig($);
    } catch (error) {
      return column([
        heading(),
        Text({ color: "error", children: errorMessage(error) }),
        Button({
          key: "menu:close",
          label: "Close",
          plain: true,
          autoFocus: true,
          onPress: closePane,
        }),
      ]);
    }
    const [rows, key] = await Promise.all([$.config.list(), resolvedKey($)]);
    const savedKey = readSavedApiKey(rows, loadedOptions) !== undefined;

    /** A list of rows the ring moves through; the one at `focus` takes it first. */
    const list = (
      entries: { key: string; label: string; onPress: () => void; dim?: boolean }[],
      focus: string,
    ) => {
      const width = Math.max(...entries.map((entry) => entry.label.length));
      return column(
        entries.map((entry) =>
          Button({
            key: entry.key,
            label: entry.label.padEnd(width),
            plain: true,
            ...(entry.dim ? { dimColor: true } : {}),
            ...(entry.key === focus ? { autoFocus: true } : {}),
            onPress: entry.onPress,
          }),
        ),
      );
    };
    /** A view of options: the current one marked; picking it, or Back, only returns. */
    const options = <T extends string>(
      crumb: string,
      current: T,
      choices: { value: T; label: string }[],
      pick: (value: T) => void,
    ) =>
      column([
        heading(crumb),
        list(
          [
            ...choices.map((choice) => ({
              key: `${view}:${choice.value}`,
              label: `${choice.value === current ? "●" : " "} ${choice.label}`,
              onPress: () => {
                showMenu();
                if (choice.value === current) void redraw();
                else pick(choice.value);
              },
            })),
            { key: "back", label: "  Back", dim: true, onPress: back },
          ],
          `${view}:${current}`,
        ),
        hint("back"),
      ]);

    if (view === "mode") {
      return options(
        "Mode",
        config.mode,
        (["hint", "auto", "off"] as const).map((value) => ({ value, label: MODE_LABELS[value] })),
        (mode) => run(() => changeMode($, mode, true)),
      );
    }
    if (view === "logging") {
      return options(
        "Log TypeSafe requests",
        config.logRequests ? "on" : "off",
        [
          { value: "off", label: "Off (default)" },
          { value: "on", label: "On" },
        ],
        (value) => run(() => changeLogRequests($, value === "on")),
      );
    }
    if (view === "minimum") {
      return column([
        heading("Minimum context"),
        Input({
          key: "minimum",
          label: "Tokens",
          value: minimumDraft?.text ?? String(config.minContextTokens),
          placeholder: String(DEFAULT_MINIMUM),
          submitLabel: "save",
          autoFocus: true,
          onSubmit: (text: string) => {
            run(async () => {
              try {
                if (await changeMinimum($, text)) showMenu();
                else minimumDraft = { text };
              } catch (error) {
                minimumDraft = { text, error: errorMessage(error) };
              }
            });
          },
        }),
        minimumDraft?.error
          ? Text({ color: "error", children: minimumDraft.error })
          : Text({
              dimColor: true,
              children: "A token count, not a percentage; no judgment below it.",
            }),
        list([{ key: "back", label: "Back", dim: true, onPress: back }], ""),
        hint("back"),
      ]);
    }
    if (view === "key") {
      return column([
        heading("TypeSafe API key"),
        Text({ dimColor: true, wrap: "wrap", children: keyDetail(key.source, savedKey) }),
        Input({
          key: "typesafeApiKey",
          label: "Key",
          value: keyDraft?.text ?? "",
          placeholder: savedKey ? "paste a key to replace the saved one" : "paste a key to save it",
          submitLabel: "save",
          autoFocus: true,
          onSubmit: (text: string) => {
            run(async () => {
              try {
                if (await changeSavedApiKey($, text)) showMenu();
                else keyDraft = { text };
              } catch (error) {
                keyDraft = { text, error: errorMessage(error) };
              }
            });
          },
        }),
        ...(keyDraft?.error ? [Text({ color: "error", children: keyDraft.error })] : []),
        list(
          [
            ...(savedKey
              ? [
                  {
                    key: "clearKey",
                    label: "Clear saved key",
                    onPress: () => {
                      run(async () => {
                        if (await clearSavedApiKey($)) showMenu();
                      });
                    },
                  },
                ]
              : []),
            { key: "back", label: "Back", dim: true, onPress: back },
          ],
          "",
        ),
        hint("back"),
      ]);
    }

    const modeValue = `${MODE_LABELS[config.mode]}${
      config.mode === "auto" && !config.autoAcknowledged ? ", not confirmed" : ""
    }`;
    const setting = (label: string, value: string) => `${label.padEnd(24)}${value}`;
    const open = (target: Exclude<PaneView, "menu">, row: string, focus: string) => () => {
      openView(target, row, focus);
      void redraw();
    };
    return column([
      heading(),
      list(
        [
          {
            key: "menu:mode",
            label: setting("Mode", modeValue),
            onPress: open("mode", "menu:mode", `mode:${config.mode}`),
          },
          {
            key: "menu:minimum",
            label: setting("Minimum context", `${formatTokens(config.minContextTokens)} tokens`),
            onPress: open("minimum", "menu:minimum", "minimum"),
          },
          {
            key: "menu:logRequests",
            label: setting("Log TypeSafe requests", config.logRequests ? "On" : "Off"),
            onPress: open(
              "logging",
              "menu:logRequests",
              `logging:${config.logRequests ? "on" : "off"}`,
            ),
          },
          {
            key: "menu:typesafeApiKey",
            label: setting("TypeSafe API key", KEY_SOURCE_LABELS[key.source]),
            onPress: open("key", "menu:typesafeApiKey", "typesafeApiKey"),
          },
          {
            key: "menu:reset",
            label: `Reset minimum to ${formatTokens(DEFAULT_MINIMUM)}`,
            onPress: () => {
              menuRow = "menu:reset";
              run(() => changeMinimum($, "default"));
            },
          },
          {
            key: "menu:status",
            label: "Status",
            onPress: () => {
              menuRow = "menu:status";
              run(async () => {
                statusDetails = await statusText($);
              });
            },
          },
          { key: "menu:close", label: "Close", onPress: closePane },
        ],
        menuRow,
      ),
      ...(statusDetails ? [Text({ dimColor: true, wrap: "wrap", children: statusDetails })] : []),
      hint("close"),
    ]);
  });
};
