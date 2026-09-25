import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { COOLDOWN_TEXT, cooldown } from "./checkpoint.ts";
export const STATE_TYPE = "compact-adviser:state";
export interface SessionState {
  version: 1;
  compactionId: string | null;
  baseline: number | null;
  completed: number;
  lastSettled: string | null;
  lastHintAt: number | null;
  lastHintKey: string | null;
  /** Context tokens and `completed` at the latest judgment that did not act; null when none. */
  judgedTokens: number | null;
  judgedAt: number | null;
  snoozeUntil: number;
  retryAfter: number;
  failures: number;
}
export function compactionId(branch: readonly SessionEntry[]): string | null {
  return [...branch].reverse().find((e) => e.type === "compaction")?.id ?? null;
}
export function initialState(compaction: string | null): SessionState {
  return {
    version: 1,
    compactionId: compaction,
    baseline: null,
    completed: 0,
    lastSettled: null,
    lastHintAt: null,
    lastHintKey: null,
    judgedTokens: null,
    judgedAt: null,
    snoozeUntil: 0,
    retryAfter: 0,
    failures: 0,
  };
}
export function restoreState(branch: readonly SessionEntry[]): SessionState {
  const compact = compactionId(branch);
  const entry = [...branch]
    .reverse()
    .find((e) => e.type === "custom" && e.customType === STATE_TYPE);
  if (entry?.type !== "custom") return initialState(compact);
  const s = entry.data as SessionState | null;
  if (
    s?.version !== 1 ||
    s.compactionId !== compact ||
    ![s.completed, s.snoozeUntil, s.failures].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    !Number.isFinite(s.retryAfter) ||
    s.retryAfter < 0 ||
    !(s.baseline === null || (Number.isFinite(s.baseline) && s.baseline >= 0)) ||
    !(s.lastHintAt === null || (Number.isSafeInteger(s.lastHintAt) && s.lastHintAt >= 0)) ||
    !(s.lastSettled === null || typeof s.lastSettled === "string") ||
    !(s.lastHintKey === null || typeof s.lastHintKey === "string") ||
    !(s.judgedTokens == null || (Number.isFinite(s.judgedTokens) && s.judgedTokens >= 0)) ||
    !(s.judgedAt == null || (Number.isSafeInteger(s.judgedAt) && s.judgedAt >= 0))
  ) {
    return { ...initialState(compact), snoozeUntil: 3 };
  }
  // Records written before the re-ask gate existed carry neither field.
  return { ...s, judgedTokens: s.judgedTokens ?? null, judgedAt: s.judgedAt ?? null };
}
export function lastResponse(branch: readonly SessionEntry[]) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === "compaction") return undefined;
    if (e.type === "message" && e.message.role === "assistant")
      return { id: e.id, message: e.message };
  }
  return undefined;
}
/** The shared cooldown gates, read against this host's record of the latest compaction. */
export function cooldownReason(
  state: SessionState,
  tokens: number,
  now: number,
): string | undefined {
  const reason = cooldown(state, state.compactionId !== null, tokens, now);
  return reason === undefined ? undefined : COOLDOWN_TEXT[reason];
}
