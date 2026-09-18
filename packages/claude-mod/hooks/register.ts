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
import type { EngineInterface, PluginOptions, Register } from "claude-code";
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
import { formatKeyStatus, parseDotenvKey, resolveTypesafeApiKey } from "../lib/env.ts";
import {
  floorFor,
  JUDGE_DISABLED_NETWORK_MESSAGE,
  JUDGE_UNAVAILABLE_MESSAGE,
  JudgeError,
  judge,
  qualifies,
  requestBody,
} from "../lib/judge.ts";
import { requestLogLine, requestLogPath } from "../lib/log.ts";
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
const HINT = "Potential session boundary detected. Run /compact to save tokens.";
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
let minimumDraft: { text: string; error: string } | undefined;
let keyDraft: { text: string; error: string } | undefined;
let statusDetails: string | undefined;

function isActivated($: EngineInterface): Promise<boolean> {
  if (activation === undefined) {
    activation = $.env.get("CLAUDE_CODE_ENABLE_FUNCTION_HOOKS").then(
      (value) => value === "1",
      () => false,
    );
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

async function logHome($: EngineInterface): Promise<string> {
  return ((await $.env.get("HOME")) ?? (await $.session.cwd())).replace(/[\\/]+$/, "");
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

/** Context tokens over the model's window, or NaN when the engine does not know it (strictest floor). */
function usageFraction(context: { tokens?: number; window: number }): number {
  if (
    typeof context.tokens !== "number" ||
    !Number.isFinite(context.tokens) ||
    !Number.isFinite(context.window) ||
    context.window <= 0
  )
    return Number.NaN;
  return context.tokens / context.window;
}

async function eligible(
  $: EngineInterface,
  config: Config,
  state: SessionState,
  tokens: number | undefined,
  now: number,
): Promise<boolean> {
  return (
    interactive &&
    !compacting &&
    config.mode !== "off" &&
    (await apiKey($)) !== "" &&
    typeof tokens === "number" &&
    Number.isFinite(tokens) &&
    tokens >= config.minContextTokens &&
    cooldownReason(state, tokens, now) === undefined
  );
}

/** The scheduled half of a turn end: judge, then hint or (opt-in) compact. */
async function judgeCheckpoint($: EngineInterface, epoch: number): Promise<void> {
  if (epoch !== generation || judging || compacting) return;
  judging = true;
  try {
    const initial = await loadConfig($);
    const [messages, activeKey, rows] = await Promise.all([
      $.session.messages(),
      apiKey($),
      $.config.list(),
    ]);
    const view = snapshot(messages, [activeKey, readSavedApiKey(rows, loadedOptions)]);
    if (view.conversationTokens <= 20000) return;
    const fingerprint = await checkpointKey(view.checkpointText);
    if ((await loadState($)).state.lastHintKey === fingerprint) return;
    if (initial.logRequests) {
      try {
        const path = requestLogPath(await logHome($));
        let existing = "";
        try {
          existing = await $.fs.read(path);
        } catch {
          existing = "";
        }
        await $.fs.write(path, `${existing}${requestLogLine(requestBody(view.state))}`);
      } catch {
        // Request logging must not replace or delay the judgment.
      }
    }
    const endpoint = await testEndpoint($);
    let result: Awaited<ReturnType<typeof judge>>;
    try {
      result = await judge(view.state, await apiKey($), {
        fetch: (url, init) => $.http.fetch(url, init),
        sleep: (ms) => $.clock.sleep(ms),
        ...(endpoint ? { endpoint } : {}),
      });
    } catch (error) {
      if (epoch !== generation) return;
      const { key, state } = await loadState($);
      await $.store.set(key, backoff(state, await $.clock.now()));
      notice($, judgeFailureMessage(error));
      return;
    }
    if (epoch !== generation) return;
    const latest = await loadConfig($);
    const { key, state: current } = await loadState($);
    const now = await $.clock.now();
    const { context } = await $.session.usage();
    if (
      JSON.stringify(latest) !== JSON.stringify(initial) ||
      !(await eligible($, latest, current, context.tokens, now))
    )
      return;
    let state: SessionState = { ...current, failures: 0, retryAfter: 0, updatedAt: now };
    const auto = latest.mode === "auto";
    if (!qualifies(result, usageFraction(context)) || (auto && !latest.autoAcknowledged)) {
      await $.store.set(key, state);
      return;
    }
    diagnostic = "";
    if (!auto) {
      state = { ...state, lastHintAt: state.completed, lastHintKey: fingerprint };
      await $.store.set(key, state);
      if (epoch !== generation) return;
      hintVisible = true;
      $.ui.status(HINT);
      $.ui.toast(HINT, { timeoutMs: 8000 });
      void $.prompt.suggest({ text: "/compact" }).catch(() => undefined);
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
    if (failure !== undefined) {
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
    notice($, error instanceof Error ? error.message : "Cannot read compact-adviser settings.");
    return;
  }
  if (judging || !(await eligible($, config, state, context.tokens, now))) return;
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
  await $.store.set(PENDING_NOTICE_KEY, { message, at: await $.clock.now() });
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

/** Shows and clears a save confirmation, whichever environment gets to it first. */
async function showPendingNotice($: EngineInterface): Promise<void> {
  const pending = (await $.store.get(PENDING_NOTICE_KEY)) as { message?: unknown; at?: unknown };
  if (pending === undefined) return;
  await $.store.delete(PENDING_NOTICE_KEY);
  const fresh = typeof pending.at === "number" && (await $.clock.now()) - pending.at < 30000;
  if (fresh && typeof pending.message === "string") {
    $.ui.toast(pending.message, { timeoutMs: 6000 });
  }
}

async function saveConsent($: EngineInterface, patch: Partial<Omit<Consent, "version">>) {
  await invalidate($);
  await $.store.set(CONSENT_STORE_KEY, { ...(await loadConsent($)), ...patch });
  diagnostic = "";
}

function openPane($: EngineInterface): Promise<void> {
  return $.ui.open({
    id: PANE_ID,
    title: "Compact adviser (saved for all sessions)",
    focus: true,
    closeOnEscape: true,
    rows: 14,
  });
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
      ? `TypeSafe request logging on (all sessions). ${requestLogPath(await logHome($))}`
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

async function clearSavedApiKey($: EngineInterface): Promise<void> {
  await saveRow(
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
  return `Mode: ${config.mode}${config.mode === "auto" && !config.autoAcknowledged ? " (not confirmed)" : ""}. Minimum: ${formatTokens(config.minContextTokens)} tokens. Context: ${typeof tokens === "number" ? formatTokens(tokens) : "unknown"}${Number.isFinite(usageFraction(usage.context)) ? ` (${Math.round(usageFraction(usage.context) * 100)}% of the window; hint floor ${floorFor(usageFraction(usage.context)).toFixed(2)})` : ""}. ${formatKeyStatus((await resolvedKey($)).source)}. ${cooldown}${engine} Request log: ${config.logRequests ? requestLogPath(await logHome($)) : "off"}. Settings: /config (compact-adviser rows) and /compact-adviser.`;
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
    generation++;
    judging = false;
    compacting = false;
    hintVisible = false;
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
    if (e.agentId !== undefined || e.reason !== "answer" || e.isAborted || !e.answer.trim()) {
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
    if (!(await isActivated($))) return result;
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
        minimumDraft = undefined;
        keyDraft = undefined;
        statusDetails = undefined;
        await openPane($);
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

  // The settings pane: the Pi extension's menu rows as engine elements.
  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (!(await isActivated($)) || e.requestId !== PANE_ID) return next(e);
    if (e.surface !== "terminal") {
      const { Text } = $.ui.resolve(e);
      return Text({ children: USAGE });
    }
    const { Box, Text, Select, Input, Button } = $.ui.resolve(e);
    let config: Config;
    try {
      config = await loadConfig($);
    } catch (error) {
      return Box({
        flexDirection: "column",
        children: [
          Text({ color: "error", children: errorMessage(error) }),
          Button({ key: "close", label: "Close", onPress: () => void $.ui.close({ id: PANE_ID }) }),
        ],
      });
    }
    const redraw = () => $.ui.invalidate("ui.render");
    const run = (action: () => Promise<unknown>) => {
      void action()
        .catch((error) => $.ui.toast(errorMessage(error), { timeoutMs: 8000 }))
        .finally(redraw);
    };
    const savedKey = readSavedApiKey(await $.config.list(), loadedOptions);
    const children = [
      Select({
        key: "mode",
        label: "Mode",
        value: config.mode,
        autoFocus: true,
        options: [
          { value: "hint", label: "Hints only (default)" },
          { value: "auto", label: "Automatic (experimental)" },
          { value: "off", label: "Off" },
        ],
        onSelect: (mode: string) => {
          if (mode !== config.mode) run(() => changeMode($, mode as Mode, true));
        },
      }),
      Select({
        key: "logRequests",
        label: "Log TypeSafe requests",
        value: config.logRequests ? "on" : "off",
        options: [
          { value: "off", label: "Off (default)" },
          { value: "on", label: "On" },
        ],
        onSelect: (value: string) => {
          const enabled = value === "on";
          if (enabled !== config.logRequests) run(() => changeLogRequests($, enabled));
        },
      }),
      Input({
        key: "minimum",
        label: "Minimum context tokens",
        value: minimumDraft?.text ?? String(config.minContextTokens),
        placeholder: String(DEFAULT_MINIMUM),
        submitLabel: "save",
        onSubmit: (text: string) => {
          run(async () => {
            try {
              await changeMinimum($, text);
              minimumDraft = undefined;
            } catch (error) {
              minimumDraft = { text, error: errorMessage(error) };
            }
          });
        },
      }),
      minimumDraft
        ? Text({ color: "error", children: `  ${minimumDraft.error}` })
        : Text({
            dimColor: true,
            children: "  A token count, not a percentage; no judgment below it.",
          }),
      Text({
        dimColor: true,
        children: `TypeSafe API key: ${savedKey ? "saved" : "not saved"}`,
      }),
      Input({
        key: "typesafeApiKey",
        label: "TypeSafe API key",
        value: keyDraft?.text ?? "",
        placeholder: savedKey ? "saved · type to replace" : "paste key to save",
        submitLabel: "set",
        onSubmit: (text: string) => {
          run(async () => {
            try {
              await changeSavedApiKey($, text);
              keyDraft = undefined;
            } catch (error) {
              keyDraft = { text, error: errorMessage(error) };
            }
          });
        },
      }),
      ...(keyDraft ? [Text({ color: "error", children: `  ${keyDraft.error}` })] : []),
      ...(savedKey
        ? [
            Button({
              key: "clearKey",
              label: "Clear saved key",
              onPress: () => {
                keyDraft = undefined;
                run(() => clearSavedApiKey($));
              },
            }),
          ]
        : []),
      Button({
        key: "reset",
        label: `Reset minimum to ${formatTokens(DEFAULT_MINIMUM)}`,
        onPress: () => {
          minimumDraft = undefined;
          run(() => changeMinimum($, "default"));
        },
      }),
      Button({
        key: "status",
        label: "Status",
        onPress: () =>
          run(async () => {
            statusDetails = await statusText($);
          }),
      }),
      ...(statusDetails ? [Text({ dimColor: true, children: statusDetails })] : []),
      Button({ key: "close", label: "Close", onPress: () => void $.ui.close({ id: PANE_ID }) }),
    ];
    return Box({ flexDirection: "column", children });
  });
};
