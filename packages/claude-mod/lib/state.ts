// Per-session cooldown facts, the Claude Code counterpart of the Pi extension's session
// entries. They live in the plugin's own store under `session:<id>`, so a restart, a hot
// reload, or a mode change never resets a session's cooldowns.

export const SESSION_PREFIX = "session:";
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionState {
  version: 1;
  /** Whether any compaction (manual, automatic, or this mod's) has run in this session. */
  compacted: boolean;
  /** The first known context size after the latest compaction. */
  baseline: number | null;
  /** Completed main-loop exchanges since the latest compaction (or session start). */
  completed: number;
  lastHintAt: number | null;
  lastHintKey: string | null;
  snoozeUntil: number;
  retryAfter: number;
  failures: number;
  updatedAt: number;
}

export function sessionKey(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

export function initialState(compacted: boolean, now: number): SessionState {
  return {
    version: 1,
    compacted,
    baseline: null,
    completed: 0,
    lastHintAt: null,
    lastHintKey: null,
    snoozeUntil: 0,
    retryAfter: 0,
    failures: 0,
    updatedAt: now,
  };
}

function count(n: unknown): n is number {
  return Number.isSafeInteger(n) && (n as number) >= 0;
}

/** A malformed record restarts conservatively: treated as just compacted and snoozed. */
export function restoreState(value: unknown, now: number): SessionState {
  if (value === undefined) return initialState(false, now);
  const s = value as Partial<SessionState> | null;
  if (
    !s ||
    typeof s !== "object" ||
    s.version !== 1 ||
    typeof s.compacted !== "boolean" ||
    ![s.completed, s.snoozeUntil, s.failures].every(count) ||
    typeof s.retryAfter !== "number" ||
    !Number.isFinite(s.retryAfter) ||
    s.retryAfter < 0 ||
    !(s.baseline === null || (typeof s.baseline === "number" && Number.isFinite(s.baseline))) ||
    !(s.lastHintAt === null || count(s.lastHintAt)) ||
    !(s.lastHintKey === null || typeof s.lastHintKey === "string") ||
    !count(s.updatedAt)
  ) {
    return { ...initialState(true, now), snoozeUntil: 3 };
  }
  return { ...(s as SessionState) };
}

export function cooldownReason(
  state: SessionState,
  tokens: number,
  now: number,
): string | undefined {
  if (now < state.retryAfter) return "OpenRouter backoff";
  if (state.completed < state.snoozeUntil) return "Snoozed";
  if (
    state.compacted &&
    (state.baseline === null || tokens - state.baseline < 20000 || state.completed < 3)
  )
    return "Waiting for 20k new tokens and 3 completed exchanges after compaction";
  return undefined;
}

/** Records one completed exchange, taking the post-compaction baseline from fresh usage. */
export function completeExchange(
  state: SessionState,
  tokens: number | undefined,
  now: number,
): SessionState {
  const next = { ...state, completed: state.completed + 1, updatedAt: now };
  if (next.compacted && next.baseline === null && typeof tokens === "number") {
    next.baseline = tokens;
  }
  return next;
}

export function backoff(state: SessionState, now: number): SessionState {
  const failures = Math.min(state.failures + 1, 6);
  return {
    ...state,
    failures,
    retryAfter: now + Math.min(300000, 5000 * 2 ** failures),
    updatedAt: now,
  };
}

export function staleSessionKeys(
  entries: readonly { key: string; value: unknown }[],
  now: number,
): string[] {
  return entries
    .filter(({ key, value }) => {
      if (!key.startsWith(SESSION_PREFIX)) return false;
      const updatedAt = (value as { updatedAt?: unknown } | null)?.updatedAt;
      return !count(updatedAt) || now - updatedAt > SESSION_RETENTION_MS;
    })
    .map(({ key }) => key);
}
