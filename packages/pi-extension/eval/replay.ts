/**
 * Offline replay of the shipped compact-adviser checkpoint pipeline against a
 * Pi session transcript. Uses the production snapshot() so a replayed
 * checkpoint is byte-identical to what the live extension would send.
 */
import { readFileSync } from "node:fs";
import {
  buildContextEntries,
  buildSessionContext,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import { snapshot } from "../src/context.ts";

export interface Checkpoint {
  sessionFile: string;
  cwd: string;
  entryId: string;
  timestamp: string;
  /** Index of this settled checkpoint within the session. */
  ordinal: number;
  /** Real context size Pi would have reported (assistant usage totalTokens). */
  contextTokens: number;
  conversationTokens: number;
  checkpointKey: string;
  autoCoverage: boolean;
  state: unknown;
  stateBytes: number;
}

export interface LoadedSession {
  file: string;
  cwd: string;
  entries: SessionEntry[];
}

type SessionEntry = {
  id: string;
  type?: string;
  parentId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    stopReason?: string;
    usage?: {
      totalTokens?: number;
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
    content?: unknown;
  };
};

export function loadSession(file: string): LoadedSession {
  const entries = parseSessionEntries(readFileSync(file, "utf8")) as SessionEntry[];
  const header = entries.find((e) => e.type === "session") as { cwd?: string } | undefined;
  return { file, cwd: header?.cwd ?? "", entries };
}

/** Settled checkpoints: the extension only judges assistant turns that stopped cleanly. */
export function settledEntries(s: LoadedSession): SessionEntry[] {
  return s.entries.filter(
    (e) => e.type === "message" && e.message?.role === "assistant" && e.message?.stopReason === "stop",
  );
}

function contextTokensAt(s: LoadedSession, entryId: string): number {
  // Mirrors agent-session estimateContextTokens(): at a settled checkpoint the
  // checkpoint assistant message is the last usage-bearing message, trailing = 0.
  const messages = (
    buildSessionContext(buildContextEntries(s.entries as never, entryId) as never) as {
      messages: Array<{
        role?: string;
        usage?: {
          totalTokens?: number;
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
        };
        stopReason?: string;
      }>;
    }
  ).messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.usage && m.stopReason !== "aborted" && m.stopReason !== "error") {
      const u = m.usage;
      const total = u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite;
      if (total > 0) return total;
    }
  }
  return 0;
}

export function replayAt(s: LoadedSession, entry: SessionEntry, ordinal: number): Checkpoint | null {
  const ctx = {
    cwd: s.cwd,
    sessionManager: {
      buildContextEntries: () => buildContextEntries(s.entries as never, entry.id),
      getSessionFile: () => s.file,
    },
  };
  let view: ReturnType<typeof snapshot>;
  try {
    view = snapshot(ctx as never);
  } catch {
    return null;
  }
  return {
    sessionFile: s.file,
    cwd: s.cwd,
    entryId: entry.id,
    timestamp: entry.timestamp ?? "",
    ordinal,
    contextTokens: contextTokensAt(s, entry.id),
    conversationTokens: view.conversationTokens,
    checkpointKey: view.checkpointKey,
    autoCoverage: view.autoCoverage,
    state: view.state,
    stateBytes: Buffer.byteLength(JSON.stringify(view.state)),
  };
}

/** The production size/dedup gates that must pass before an OpenRouter request is made. */
export const MIN_CONTEXT_TOKENS = 40000;
export function passesSizeGates(c: Checkpoint): boolean {
  return c.contextTokens >= MIN_CONTEXT_TOKENS && c.conversationTokens > 20000;
}

export function usageTokens(entry: SessionEntry): number {
  const u = entry.message?.usage;
  return u ? (u.totalTokens || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)) : 0;
}
