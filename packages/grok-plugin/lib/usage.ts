// Context usage, from two places that disagree about how stable they are.
//
// The status-line payload's `context_window` block is documented, so the status line reads it
// straight. The Stop hook gets no usage at all, so it falls back to the session's
// `signals.json`, whose field names are NOT documented: they are read defensively and a miss
// is reported as unknown, which takes the contract's strictest hint floor rather than a guess.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contextPressure } from "./checkpoint.ts";

export interface ContextUsage {
  /** Tokens the conversation occupies right now, or undefined when nothing could read it. */
  tokens?: number;
  /** The model's context window, or undefined when it is unknown. */
  window?: number;
  /** Where the numbers came from, for `status` and the request log. */
  source: "status-line" | "signals" | "unknown";
}

export const UNKNOWN_USAGE: ContextUsage = { source: "unknown" };

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Context tokens over the budget or the window; NaN when neither is known (strictest floor). */
export function usageFraction(usage: ContextUsage, budget: number): number {
  if (usage.tokens === undefined) return Number.NaN;
  return contextPressure(usage.tokens, usage.window ?? Number.NaN, budget);
}

/** `signals.json` written next to the transcript. Undocumented fields, so every one is checked. */
export function readSignalsUsage(sessionDir: string | undefined): ContextUsage {
  if (!sessionDir) return UNKNOWN_USAGE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(sessionDir, "signals.json"), "utf8"));
  } catch {
    return UNKNOWN_USAGE;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return UNKNOWN_USAGE;
  const signals = parsed as Record<string, unknown>;
  const tokens = count(signals.contextTokensUsed);
  const window = count(signals.contextWindowTokens);
  if (tokens === undefined && window === undefined) return UNKNOWN_USAGE;
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(window === undefined || window === 0 ? {} : { window }),
    source: "signals",
  };
}

/** The documented `context_window` block of a status-line payload. */
export function readPayloadUsage(payload: unknown): ContextUsage {
  const block = (payload as { context_window?: unknown } | null)?.context_window;
  if (!block || typeof block !== "object") return UNKNOWN_USAGE;
  const window = block as Record<string, unknown>;
  const tokens = count(window.context_tokens);
  const size = count(window.context_window_size);
  if (tokens === undefined && size === undefined) return UNKNOWN_USAGE;
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(size === undefined || size === 0 ? {} : { window: size }),
    source: "status-line",
  };
}
