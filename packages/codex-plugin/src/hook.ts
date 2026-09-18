// compact-adviser for Codex CLI: the hook process of the `compact-adviser` Codex plugin.
//
// Codex runs a hook as a plain child process outside the tool sandbox, hands it the event as
// JSON on stdin, and reads JSON back on stdout. A `Stop` hook's `systemMessage` becomes a
// persistent `↳ Hook ·` line in the scrollback right under the answer, which is this host's
// hint surface. It is not a sticky, clearable widget, so a hint stays where it was printed.
//
// Codex is hint-only on purpose: no hook, plugin, or documented client surface lets an outside
// process run `/compact` on the user's session, so there is no automatic mode here.
//
// The decisions live in the sibling modules (settings, cooldowns, the bounded judge input, and
// the Jev client); this file is the only one that knows Codex's event shapes. Nothing it does
// may break a turn, so every failure path exits quietly with no hint.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "./config.ts";
import { parseDotenvKey, type ResolvedTypesafeApiKey, resolveTypesafeApiKey } from "./env.ts";
import { judge, qualifies, requestBody } from "./judge.ts";
import {
  appendRequestLogLine,
  errorLogLine,
  loggedJudgeErrorKind,
  requestLogLine,
  responseLogLine,
} from "./log.ts";
import { adviserRoot } from "./paths.ts";
import { type Rollout, readRollout, usageFraction } from "./rollout.ts";
import { snapshot } from "./snapshot.ts";
import { backoff, completeExchange, cooldownReason, initialState } from "./state.ts";
import { SessionStore } from "./store.ts";

export const HINT =
  "Compact adviser: work appears completed or recorded. Run /compact to save tokens.";
/** Below this the conversation is too small for a judgment to be worth a request. */
export const MINIMUM_CONVERSATION_TOKENS = 20000;
/** A loopback-only endpoint override for the live regression's local TypeSafe fixture. */
const LOOPBACK_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[\x21-\x7e]*$/;

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  source?: string;
  trigger?: string;
}

export interface HookOutput {
  systemMessage?: string;
}

/**
 * Only the interactive TUI judges. `codex exec` and other scripted runners settle the same
 * way, but a hint no person is watching is only a TypeSafe request nobody asked for.
 */
export function isInteractive(rollout: Pick<Rollout, "originator">): boolean {
  return rollout.originator === "codex-tui";
}

function testEndpoint(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.COMPACT_ADVISER_TEST_ENDPOINT;
  return value !== undefined && LOOPBACK_ENDPOINT.test(value) ? value : undefined;
}

/** Launch environment, then the key saved in settings, then `TYPESAFE_API_KEY` in `cwd/.env`. */
export function resolveKey(
  env: NodeJS.ProcessEnv,
  saved: string | undefined,
  cwd: string,
): ResolvedTypesafeApiKey {
  let dotenv: string | undefined;
  try {
    dotenv = parseDotenvKey(readFileSync(join(cwd, ".env"), "utf8"), "TYPESAFE_API_KEY");
  } catch {
    dotenv = undefined;
  }
  return resolveTypesafeApiKey(env.TYPESAFE_API_KEY, saved, dotenv);
}

async function checkpointKey(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Environment {
  env: NodeJS.ProcessEnv;
  now: () => number;
  fetch: typeof globalThis.fetch;
}

function cancellableJudgeTransport(fetch: Environment["fetch"]): {
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
        const text = await response.text();
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

/**
 * One completed Codex turn: count the exchange, run the cheap local gates, and only then ask
 * TypeSafe. A failed or unqualified judgment returns no hint and leaves context alone.
 */
async function onStop(payload: HookPayload, environment: Environment): Promise<HookOutput> {
  const sessionId = payload.session_id;
  const transcript = payload.transcript_path;
  if (!sessionId || !transcript) return {};
  // A hook that Codex re-entered while its own stop was still being processed must not judge
  // the same checkpoint twice.
  if (payload.stop_hook_active === true) return {};

  const root = adviserRoot(environment.env);
  const config = new ConfigStore(root).read();
  const sessions = new SessionStore(root);
  const now = environment.now();

  const rollout = readRollout(transcript);
  const usage = { tokens: rollout.tokens, window: rollout.window };
  const stored = sessions.read(sessionId, now).state;
  const state = completeExchange(stored, rollout.tokens, now);
  sessions.write(sessionId, state, usage);

  if (config.mode === "off") return {};
  if (!isInteractive(rollout)) return {};
  if (!payload.last_assistant_message?.trim()) return {};

  const key = resolveKey(environment.env, config.typesafeApiKey, payload.cwd ?? process.cwd());
  if (!key.value) return {};

  const tokens = rollout.tokens;
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return {};
  if (tokens < config.minContextTokens) return {};
  if (cooldownReason(state, tokens, now) !== undefined) return {};

  const view = snapshot(rollout.messages, [key.value, config.typesafeApiKey]);
  if (view.conversationTokens <= MINIMUM_CONVERSATION_TOKENS) return {};
  const fingerprint = await checkpointKey(view.checkpointText);
  if (state.lastHintKey === fingerprint) return {};

  let loggedBody: string | undefined;
  if (config.logRequests) {
    try {
      loggedBody = requestBody(view.state);
      appendRequestLogLine(root, sessionId, requestLogLine(loggedBody));
    } catch {
      // Request logging must not replace or delay the judgment.
    }
  }

  const endpoint = testEndpoint(environment.env);
  let result: Awaited<ReturnType<typeof judge>>;
  try {
    result = await judge(view.state, key.value, {
      ...cancellableJudgeTransport(environment.fetch),
      ...(endpoint ? { endpoint } : {}),
    });
  } catch (error) {
    if (config.logRequests) {
      try {
        appendRequestLogLine(
          root,
          sessionId,
          errorLogLine(loggedJudgeErrorKind(error), loggedBody),
        );
      } catch {
        // Error logging must not replace backoff.
      }
    }
    // Silence is the only honest report here: Codex's one channel is a permanent scrollback
    // line, and a transient TypeSafe failure is not worth one. Backoff keeps retries rare.
    const current = sessions.read(sessionId, environment.now()).state;
    sessions.write(sessionId, backoff(current, environment.now()), usage);
    return {};
  }

  const fraction = usageFraction(rollout);
  if (config.logRequests) {
    try {
      appendRequestLogLine(
        root,
        sessionId,
        responseLogLine(loggedBody ?? requestBody(view.state), result, fraction),
      );
    } catch {
      // Response logging must not replace the gate decision.
    }
  }

  const nowAfter = environment.now();
  const latestConfig = new ConfigStore(root).read();
  const current = sessions.read(sessionId, nowAfter).state;
  const settled = { ...current, failures: 0, retryAfter: 0, updatedAt: nowAfter };
  if (
    latestConfig.mode === "off" ||
    cooldownReason(current, tokens, nowAfter) !== undefined ||
    !qualifies(result, fraction)
  ) {
    sessions.write(sessionId, settled, usage);
    return {};
  }
  sessions.write(
    sessionId,
    { ...settled, lastHintAt: settled.completed, lastHintKey: fingerprint },
    usage,
  );
  return { systemMessage: HINT };
}

/** Compaction resets a session's counters: the wait gate is measured from the new baseline. */
function resetAfterCompaction(payload: HookPayload, environment: Environment): void {
  const sessionId = payload.session_id;
  if (!sessionId) return;
  const store = new SessionStore(adviserRoot(environment.env));
  store.write(sessionId, initialState(true, environment.now()));
}

export async function handle(payload: HookPayload, environment: Environment): Promise<HookOutput> {
  switch (payload.hook_event_name) {
    case "Stop":
      return onStop(payload, environment);
    case "PostCompact":
      resetAfterCompaction(payload, environment);
      return {};
    case "SessionStart": {
      const root = adviserRoot(environment.env);
      if (payload.source === "compact") resetAfterCompaction(payload, environment);
      else new SessionStore(root).prune(environment.now());
      return {};
    }
    default:
      return {};
  }
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export async function main(): Promise<void> {
  let output: HookOutput = {};
  try {
    const payload = JSON.parse(readStdin()) as HookPayload;
    output = await handle(payload, {
      env: process.env,
      now: () => Date.now(),
      fetch: globalThis.fetch,
    });
  } catch {
    // A hook is on the turn's critical path: an adviser fault must never stop a Codex turn.
    output = {};
  }
  process.stdout.write(JSON.stringify(output));
}

if (process.argv[1]?.endsWith("hook.ts")) await main();
