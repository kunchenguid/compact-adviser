// Per-session cooldown records on disk.
//
// A Codex hook is a fresh process at every event, so there is no module scratch to keep a
// session's counters in: every fact `state.ts` gates on is written back after each event and
// read again at the next one. One file per session keeps two sessions from overwriting each
// other's counters without needing a lock.
//
// Each file also carries the usage numbers the hook last read out of the rollout. Only a hook
// ever sees those, so without them the settings CLI could not say which cooldown or hint floor
// a session is under. They sit beside the shared `SessionState`, never inside it.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./config.ts";
import { initialState, restoreState, type SessionState, staleSessionKeys } from "./state.ts";

export const SESSIONS_DIRECTORY = "sessions";

export interface SessionRecord {
  state: SessionState;
  /** Tokens the session's last model request occupied, as the rollout reported them. */
  tokens: number | undefined;
  /** That model's context window. */
  window: number | undefined;
}

export interface IdentifiedSessionRecord extends SessionRecord {
  id: string;
}

/** A session id is a host-supplied string; only these characters reach the filesystem. */
export function sessionFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "session";
  return `${safe}.json`;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseRecord(value: unknown, now: number): SessionRecord {
  const record = (value ?? null) as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { state: restoreState(null, now), tokens: undefined, window: undefined };
  }
  return {
    state: restoreState(record.state, now),
    tokens: number(record.tokens),
    window: number(record.window),
  };
}

export class SessionStore {
  readonly directory: string;
  constructor(root: string) {
    this.directory = join(root, SESSIONS_DIRECTORY);
  }

  path(sessionId: string): string {
    return join(this.directory, sessionFileName(sessionId));
  }

  /** The stored record, or a fresh one; anything malformed restarts conservatively. */
  read(sessionId: string, now: number): SessionRecord {
    let raw: string;
    try {
      raw = readFileSync(this.path(sessionId), "utf8");
    } catch {
      return { state: initialState(false, now), tokens: undefined, window: undefined };
    }
    try {
      return parseRecord(JSON.parse(raw), now);
    } catch {
      return parseRecord(null, now);
    }
  }

  write(sessionId: string, state: SessionState, usage: Partial<SessionRecord> = {}): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const record: SessionRecord = {
      state,
      tokens: usage.tokens,
      window: usage.window,
    };
    writeAtomic(this.path(sessionId), `${JSON.stringify(record)}\n`);
  }

  private entries(): { name: string; record: SessionRecord; at: number }[] {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      return [];
    }
    const out: { name: string; record: SessionRecord; at: number }[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const path = join(this.directory, name);
        const record = parseRecord(JSON.parse(readFileSync(path, "utf8")), 0);
        out.push({ name, record, at: statSync(path).mtimeMs });
      } catch {
        // An unreadable record still counts as an entry so `prune` can remove it; parsing
        // `null` yields the conservative restart state, whose epoch `updatedAt` reads stale.
        out.push({ name, record: parseRecord(null, 0), at: 0 });
      }
    }
    return out;
  }

  /** The most recently written session: the one the settings CLI is almost certainly about. */
  latest(): IdentifiedSessionRecord | undefined {
    const newest = this.entries().sort((a, b) => b.at - a.at)[0];
    if (newest === undefined) return undefined;
    return { id: newest.name.replace(/\.json$/, ""), ...newest.record };
  }

  /** Drops records this product stopped caring about; a failure leaves them in place. */
  prune(now: number): void {
    // `staleSessionKeys` keys off the Claude mod's `session:` prefix, which these names take
    // on here; the retention window and the malformed-record rule are the same on both hosts.
    const stale = staleSessionKeys(
      this.entries().map((entry) => ({ key: `session:${entry.name}`, value: entry.record.state })),
      now,
    );
    for (const key of stale) {
      try {
        rmSync(join(this.directory, key.slice("session:".length)), { force: true });
      } catch {
        // Pruning is housekeeping; a failure leaves an old cooldown record in place.
      }
    }
  }
}
