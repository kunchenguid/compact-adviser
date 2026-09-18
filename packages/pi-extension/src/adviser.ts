import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Config, ConfigStore, DEFAULT_CONFIG, type Mode, parseMinimum } from "./config.ts";
import { snapshot } from "./context.ts";
import { resolveTypesafeApiKey } from "./env.ts";
import {
  JUDGE_UNAVAILABLE_MESSAGE,
  type Judgment,
  judge,
  qualifies,
  requestBody,
} from "./judge.ts";
import { appendRequestLog, requestLogPath } from "./log.ts";
import { promptMinimum } from "./minimum-input.ts";
import {
  cooldownReason,
  initialState,
  lastResponse,
  restoreState,
  type SessionState,
  STATE_TYPE,
} from "./state.ts";

const LABEL = "compact-adviser";
const HINT = "Good checkpoint: completed work appears recorded. Run /compact to save tokens.";
const USAGE =
  "Use /compact-adviser, auto, hint, off, status, threshold <tokens|default>, snooze or dismiss.";
interface Options {
  agentDir: string;
  version: string;
  key?: () => string | undefined;
  now?: () => number;
  evaluate?: (state: unknown, key: string, signal: AbortSignal) => Promise<Judgment>;
}
export function installAdviser(pi: ExtensionAPI, options: Options): void {
  const store = new ConfigStore(options.agentDir);
  const key = options.key ?? (() => resolveTypesafeApiKey());
  const now = options.now ?? Date.now;
  const evaluate = options.evaluate ?? judge;
  const [major, minor] = options.version.split(".").map(Number);
  const supported = Number.isFinite(major) && (major > 0 || minor >= 82);
  let generation = 0;
  let lifetime = 0;
  let request: AbortController | undefined;
  let compacting = false;
  let automaticCompaction = false;
  let hintVisible = false;
  let diagnostic = "";
  const uiAvailable = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI;
  function persist(state: SessionState) {
    pi.appendEntry(STATE_TYPE, state);
  }
  function clearStatus(ctx: ExtensionContext) {
    if (uiAvailable(ctx)) ctx.ui.setStatus(LABEL, undefined);
  }
  function notice(ctx: ExtensionContext, message: string) {
    if (!uiAvailable(ctx) || diagnostic === message) return;
    diagnostic = message;
    ctx.ui.notify(message, "warning");
  }
  function refresh(ctx: ExtensionContext) {
    try {
      store.read();
    } catch {
      notice(ctx, "Cannot read compact-adviser settings; automatic action is disabled.");
    }
  }
  function invalidate(ctx: ExtensionContext) {
    generation++;
    request?.abort();
    request = undefined;
    if (hintVisible && uiAvailable(ctx)) ctx.ui.setWidget(LABEL, undefined);
    hintVisible = false;
  }
  function eligible(ctx: ExtensionContext, c: Config, s: SessionState): number | undefined {
    const usage = ctx.getContextUsage();
    if (
      !supported ||
      !ctx.model ||
      !uiAvailable(ctx) ||
      compacting ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      ctx.ui.getEditorText?.().trim() ||
      c.mode === "off" ||
      !key()?.trim() ||
      !usage ||
      usage.tokens === null ||
      !Number.isFinite(usage.tokens) ||
      !Number.isFinite(usage.contextWindow) ||
      usage.contextWindow <= 0 ||
      usage.tokens < c.minContextTokens ||
      cooldownReason(s, usage.tokens, now())
    )
      return undefined;
    return usage.tokens;
  }
  function sessionIdentity(ctx: ExtensionContext) {
    return JSON.stringify([
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getLeafId(),
      ctx.model?.provider,
      ctx.model?.id,
    ]);
  }
  async function settled(ctx: ExtensionContext) {
    if (!uiAvailable(ctx)) return;
    let state = restoreState(ctx.sessionManager.getBranch());
    const last = lastResponse(ctx.sessionManager.getBranch());
    if (last?.message.stopReason !== "stop" || state.lastSettled === last.id) return;
    state = { ...state, lastSettled: last.id, completed: state.completed + 1 };
    const tokens = ctx.getContextUsage()?.tokens;
    if (
      state.compactionId &&
      state.baseline === null &&
      typeof tokens === "number" &&
      Number.isFinite(tokens)
    )
      state.baseline = tokens;
    persist(state);
    let config: Config;
    try {
      config = store.read();
    } catch {
      refresh(ctx);
      return;
    }
    if (request || eligible(ctx, config, state) === undefined) return;
    const view = snapshot(ctx);
    if (view.conversationTokens <= 20000 || view.checkpointKey === state.lastHintKey) return;
    if (config.logRequests) {
      try {
        appendRequestLog(options.agentDir, requestBody(view.state));
      } catch {
        // Request logging must not replace or delay the judgment.
      }
    }
    const controller = new AbortController();
    request = controller;
    const epoch = generation,
      identity = sessionIdentity(ctx),
      configIdentity = JSON.stringify(config);
    const current = () =>
      !controller.signal.aborted && generation === epoch && sessionIdentity(ctx) === identity;
    try {
      const result = await evaluate(view.state, key()?.trim() ?? "", controller.signal);
      if (!current()) return;
      // No await between this final cross-session configuration/state check and compact().
      const latest = store.read();
      if (JSON.stringify(latest) !== configIdentity || eligible(ctx, latest, state) === undefined)
        return;
      state = { ...state, failures: 0, retryAfter: 0 };
      const auto = latest.mode === "auto";
      if (!qualifies(result)) {
        persist(state);
        return;
      }
      if (auto && !latest.autoAcknowledged) {
        persist(state);
        return;
      }
      diagnostic = "";
      if (!auto) {
        state = { ...state, lastHintAt: state.completed, lastHintKey: view.checkpointKey };
        persist(state);
        ctx.ui.notify(HINT, "info");
        ctx.ui.setWidget(LABEL, [HINT, "/compact-adviser snooze · /compact-adviser dismiss"]);
        hintVisible = true;
      } else {
        compacting = true;
        automaticCompaction = true;
        const owner = lifetime;
        ctx.ui.notify("Compact adviser: compacting at a checkpoint (experimental auto).", "info");
        ctx.compact({
          onComplete: () => {
            if (lifetime !== owner) return;
            compacting = false;
            automaticCompaction = false;
            // session_compact owns the successful checkpoint reset, including native compactions.
            refresh(ctx);
            ctx.ui.notify("Compact adviser: compaction completed.", "info");
          },
          onError: () => {
            if (lifetime !== owner) return;
            compacting = false;
            automaticCompaction = false;
            const latestState = restoreState(ctx.sessionManager.getBranch());
            persist({ ...latestState, retryAfter: now() + 60000 });
            notice(
              ctx,
              "Compaction failed or was cancelled. No immediate retry; Pi remains in control.",
            );
          },
        });
      }
    } catch (error) {
      if (!current()) return;
      const failures = Math.min(state.failures + 1, 6);
      persist({ ...state, failures, retryAfter: now() + Math.min(300000, 5000 * 2 ** failures) });
      notice(
        ctx,
        error instanceof Error && error.name === "JudgeError"
          ? error.message
          : JUDGE_UNAVAILABLE_MESSAGE,
      );
    } finally {
      if (request === controller) request = undefined;
    }
  }
  pi.on("turn_end", (_event, ctx) => {
    if (!ctx.isIdle() && hintVisible) invalidate(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    void settled(ctx).catch(() =>
      notice(ctx, "Compact adviser could not inspect this checkpoint; context left unchanged."),
    );
  });
  pi.on("session_start", (_event, ctx) => {
    lifetime++;
    invalidate(ctx);
    compacting = false;
    automaticCompaction = false;
    clearStatus(ctx);
    refresh(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    invalidate(ctx);
    compacting = false;
    automaticCompaction = false;
  });
  pi.on("input", (_event, ctx) => {
    invalidate(ctx);
  });
  pi.on("session_before_compact", (event, ctx) => {
    invalidate(ctx);
    compacting = true;
    // The judgment assumes Pi's ordinary recent tail. Inspect the native
    // preparation, not duplicated settings-file discovery, before summarization.
    if (automaticCompaction && event.preparation.settings.keepRecentTokens < 20000) {
      notice(
        ctx,
        "Automatic compaction skipped: Pi is configured to retain less than 20k recent tokens. Use /compact manually if appropriate.",
      );
      return { cancel: true };
    }
  });
  pi.on("session_compact", (event, ctx) => {
    if (!uiAvailable(ctx)) return;
    invalidate(ctx);
    compacting = false;
    automaticCompaction = false;
    persist(initialState(event.compactionEntry.id));
    refresh(ctx);
  });
  pi.on("session_before_switch", (_event, ctx) => {
    lifetime++;
    invalidate(ctx);
  });
  pi.on("session_before_fork", (_event, ctx) => {
    lifetime++;
    invalidate(ctx);
  });
  pi.on("session_before_tree", (_event, ctx) => {
    lifetime++;
    invalidate(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    invalidate(ctx);
    compacting = false;
    automaticCompaction = false;
    refresh(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    invalidate(ctx);
    const s = restoreState(ctx.sessionManager.getBranch());
    if (uiAvailable(ctx) && s.compactionId) persist({ ...s, baseline: null });
    refresh(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    lifetime++;
    invalidate(ctx);
    compacting = false;
    automaticCompaction = false;
    clearStatus(ctx);
  });

  function save(ctx: ExtensionContext, patch: Partial<Config>, message: string) {
    invalidate(ctx);
    store.update(patch);
    diagnostic = "";
    ctx.ui.notify(message, "info");
  }
  async function changeMode(ctx: ExtensionCommandContext, mode: Mode) {
    if (mode === "auto") {
      if (!supported) throw new Error("Automatic mode requires Pi 0.82.0 or newer.");
      if (!store.read().autoAcknowledged) {
        if (
          !(await ctx.ui.confirm(
            "Enable experimental automatic compaction?",
            "This persists across all Pi sessions and projects. Compaction is lossy and timing accuracy is not proven. It only acts at eligible checkpoints; it does not compact immediately.",
          ))
        )
          return;
      }
      save(
        ctx,
        { mode, autoAcknowledged: true },
        "Automatic mode saved (all sessions). A TypeSafe key is still required.",
      );
    } else
      save(
        ctx,
        { mode },
        `${mode === "hint" ? "Hints only" : "Off"} saved (all sessions). Pi's built-in compaction is unchanged.`,
      );
  }
  function minimum(ctx: ExtensionCommandContext, text: string) {
    const count = text === "default" ? DEFAULT_CONFIG.minContextTokens : parseMinimum(text);
    save(
      ctx,
      { minContextTokens: count },
      `Minimum context saved: ${count.toLocaleString("en-US")} tokens (all sessions).`,
    );
    if (ctx.model && count >= ctx.model.contextWindow)
      ctx.ui.notify(
        "This minimum is at or above the active model's context window. Opportunistic advice will not trigger before native compaction.",
        "warning",
      );
  }
  function status(ctx: ExtensionCommandContext) {
    const c = store.read(),
      s = restoreState(ctx.sessionManager.getBranch()),
      t = ctx.getContextUsage()?.tokens;
    ctx.ui.notify(
      `Mode: ${c.mode}. Minimum: ${c.minContextTokens.toLocaleString("en-US")} tokens. Context: ${t ?? "unknown"}. Key: ${key()?.trim() ? "present" : "missing"}. ${typeof t === "number" ? (cooldownReason(s, t, now()) ?? "No cooldown; semantic checks still apply.") : "Waiting for fresh model usage."} Request log: ${c.logRequests ? requestLogPath(options.agentDir) : "off"}. Settings: ${store.path}`,
      "info",
    );
  }
  async function changeLogRequests(ctx: ExtensionCommandContext, enabled: boolean) {
    save(
      ctx,
      { logRequests: enabled },
      enabled
        ? `TypeSafe request logging on (all sessions). ${requestLogPath(options.agentDir)}`
        : "TypeSafe request logging off (all sessions).",
    );
  }
  async function menu(ctx: ExtensionCommandContext) {
    while (true) {
      const c = store.read();
      const labels = [
        `Mode: ${c.mode}`,
        `Minimum context: ${c.minContextTokens.toLocaleString("en-US")} tokens`,
        `Log TypeSafe requests: ${c.logRequests ? "on" : "off"}`,
        "Reset minimum to 40,000",
        "Status",
        "Close",
      ];
      const selected = await ctx.ui.select("Compact adviser (saved for all sessions)", labels);
      if (!selected || selected === "Close") return;
      if (selected === labels[0]) {
        const mode = await ctx.ui.select("Mode", [
          "Hints only (default)",
          "Automatic (experimental)",
          "Off",
        ]);
        if (mode)
          await changeMode(
            ctx,
            mode.startsWith("Hints") ? "hint" : mode.startsWith("Automatic") ? "auto" : "off",
          );
      } else if (selected === labels[1]) {
        while (true) {
          const input = await promptMinimum(ctx, store.read().minContextTokens);
          if (input === undefined) break;
          try {
            minimum(ctx, input);
            break;
          } catch (error) {
            ctx.ui.notify(
              error instanceof Error ? error.message : "Could not save minimum.",
              "error",
            );
          }
        }
      } else if (selected === labels[2]) {
        const logging = await ctx.ui.select("Log TypeSafe requests", ["Off (default)", "On"]);
        if (logging) await changeLogRequests(ctx, logging.startsWith("On"));
      } else if (selected === labels[3]) minimum(ctx, "default");
      else status(ctx);
    }
  }
  pi.registerCommand("compact-adviser", {
    description: "Configure persistent compaction advice, experimental auto, and token minimum",
    getArgumentCompletions: (prefix) =>
      ["auto", "hint", "off", "status", "threshold ", "threshold default", "snooze", "dismiss"]
        .filter((v) => v.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!uiAvailable(ctx)) return;
      try {
        const [command, ...rest] = args.trim().split(/\s+/);
        const value = rest.join(" ");
        if (!command) await menu(ctx);
        else if (["auto", "hint", "off"].includes(command) && !value)
          await changeMode(ctx, command as Mode);
        else if (command === "threshold" && value) minimum(ctx, value);
        else if (command === "status" && !value) status(ctx);
        else if (["snooze", "dismiss"].includes(command) && !value) {
          const s = restoreState(ctx.sessionManager.getBranch());
          invalidate(ctx);
          persist({ ...s, snoozeUntil: command === "snooze" ? s.completed + 4 : s.snoozeUntil });
          ctx.ui.notify(
            command === "snooze"
              ? "Advice snoozed for three completed exchanges."
              : "Hint dismissed.",
            "info",
          );
        } else throw new Error(USAGE);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not save settings.", "error");
      }
    },
  });
}
