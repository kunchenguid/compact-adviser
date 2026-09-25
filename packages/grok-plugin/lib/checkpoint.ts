// The checkpoint policy every host shares: when a session may be judged again, and what a
// returned verdict does to its gates. Hosts own their preconditions and their storage; this
// file owns the policy between them. It is byte-identical in every host package, imports
// nothing, and uses only erasable syntax; packages/pi-extension/test/lockstep.test.ts
// compares the copies.

/** After a compaction, judging waits for this much new context and these many exchanges. */
export const AFTER_COMPACTION_TOKENS = 20000;
export const AFTER_COMPACTION_EXCHANGES = 3;
/**
 * After a judgment that did not act, the next waits for this much new context, or for these
 * many exchanges that also changed the context by `REASK_MIN_TOKENS`: exchanges that add
 * almost nothing (background notifications) do not make a new checkpoint.
 */
export const REASK_TOKENS = 20000;
export const REASK_EXCHANGES = 3;
export const REASK_MIN_TOKENS = 5000;

/**
 * The context fraction the hint floor reads: tokens over the person's context budget when
 * one is set (a positive token count), otherwise over the host's own limit. NaN when either
 * side is unknown, which takes the strictest floor.
 */
export function contextPressure(tokens: number, limit: number, budget: number): number {
  const denominator = budget > 0 ? budget : limit;
  if (!Number.isFinite(tokens) || !Number.isFinite(denominator) || denominator <= 0)
    return Number.NaN;
  return tokens / denominator;
}

/** The per-session facts the policy reads and writes; each host's record carries them. */
export interface Gates {
  /** The first known context size after the latest compaction. */
  baseline: number | null;
  /** Completed main-loop exchanges since the latest compaction (or session start). */
  completed: number;
  lastHintAt: number | null;
  lastHintKey: string | null;
  /** Context tokens and `completed` at the latest judgment that did not act; null when none. */
  judgedTokens: number | null;
  judgedAt: number | null;
  snoozeUntil: number;
  retryAfter: number;
  failures: number;
}

export type Cooldown = "backoff" | "snoozed" | "after-compaction" | "re-ask";

export const COOLDOWN_TEXT: Readonly<Record<Cooldown, string>> = {
  backoff: "TypeSafe backoff",
  snoozed: "Snoozed",
  "after-compaction": "Waiting for 20k new tokens and 3 completed exchanges after compaction",
  "re-ask":
    "Waiting for 20k new tokens, or 3 completed exchanges that change the context by 5k, since the last judgment",
};

/** Why this session may not be judged yet at `tokens`, or undefined when it may. */
export function cooldown(
  gates: Gates,
  compacted: boolean,
  tokens: number,
  now: number,
): Cooldown | undefined {
  if (now < gates.retryAfter) return "backoff";
  if (gates.completed < gates.snoozeUntil) return "snoozed";
  if (
    compacted &&
    (gates.baseline === null ||
      tokens - gates.baseline < AFTER_COMPACTION_TOKENS ||
      gates.completed < AFTER_COMPACTION_EXCHANGES)
  )
    return "after-compaction";
  if (
    gates.judgedTokens !== null &&
    gates.judgedAt !== null &&
    tokens - gates.judgedTokens < REASK_TOKENS &&
    (gates.completed - gates.judgedAt < REASK_EXCHANGES ||
      Math.abs(tokens - gates.judgedTokens) < REASK_MIN_TOKENS)
  )
    return "re-ask";
  return undefined;
}

/**
 * What a returned verdict comes to.
 * - `discard`: settings or the session changed while it was in flight; it decides nothing.
 * - `wait`: not a checkpoint yet.
 * - `unconfirmed`: a checkpoint, but automatic mode is saved without its acknowledgement.
 * - `hint` / `compact`: a checkpoint, acted on as the mode says.
 */
export type Resolution = "discard" | "wait" | "unconfirmed" | "hint" | "compact";

export function resolve(verdict: {
  /** False when the host's own re-checks found the verdict stale. */
  fresh: boolean;
  qualifies: boolean;
  mode: "hint" | "auto" | "off";
  autoAcknowledged: boolean;
}): Resolution {
  if (!verdict.fresh || verdict.mode === "off") return "discard";
  if (!verdict.qualifies) return "wait";
  if (verdict.mode !== "auto") return "hint";
  return verdict.autoAcknowledged ? "compact" : "unconfirmed";
}

/**
 * The gates after a verdict. Every answer recorded here clears the backoff. One that did not
 * act starts the re-ask gate at this checkpoint; one that acted clears it, and a hint also
 * marks the checkpoint so it is not advised twice. A discard neither starts nor clears the
 * gate; a host whose session may have moved on since the request skips recording it.
 */
export function judged<G extends Gates>(
  gates: G,
  resolution: Resolution,
  tokens: number,
  fingerprint: string,
): G {
  const answered = { ...gates, failures: 0, retryAfter: 0 };
  if (resolution === "discard") return answered;
  if (resolution === "wait" || resolution === "unconfirmed")
    return { ...answered, judgedTokens: tokens, judgedAt: gates.completed };
  const acted = { ...answered, judgedTokens: null, judgedAt: null };
  return resolution === "hint"
    ? { ...acted, lastHintAt: gates.completed, lastHintKey: fingerprint }
    : acted;
}
