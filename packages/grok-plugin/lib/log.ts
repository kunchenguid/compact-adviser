// The TypeSafe request log. The line builders are a copy of the other hosts';
// packages/pi-extension/test/lockstep.test.ts asserts every package writes the same shapes.
// Only the file location is Grok's own: one jsonl per session in the adviser's data
// directory, appended with O_APPEND because each hook run is its own process.
import { floorFor, JudgeError, type Judgment, qualifies, score } from "./judge.ts";

export const REQUEST_LOG_PREFIX = "compact-adviser-requests";

export function requestLogName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "session";
  return `${REQUEST_LOG_PREFIX}-${safe}.jsonl`;
}

export function requestLogPath(dataDir: string, sessionId: string): string {
  const root = dataDir.replace(/[\\/]+$/, "");
  return `${root}/${requestLogName(sessionId)}`;
}

/** Stable correlation id for a request body. FNV-1a 64, matching the other hosts. */
import type { JudgeProfile } from "./profile.ts";

export function requestLogId(body: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(body)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function loggedJudgeErrorKind(error: unknown): string {
  return error instanceof JudgeError ? error.kind : "unavailable";
}

export function requestLogLine(body: string, at = new Date().toISOString()): string {
  return `${JSON.stringify({ at, kind: "request", id: requestLogId(body), body: JSON.parse(body) })}\n`;
}

export function responseLogLine(
  body: string,
  judgment: Judgment,
  usage: number,
  at = new Date().toISOString(),
  profile?: JudgeProfile,
  /** The context budget the usage is measured against; recorded only when it applies. */
  budget = 0,
): string {
  return `${JSON.stringify({
    at,
    kind: "response",
    id: requestLogId(body),
    answers: {
      done: { choice: judgment.done.choice, probabilities: judgment.done.probabilities },
      shape: { choice: judgment.shape.choice, probabilities: judgment.shape.probabilities },
    },
    score: score(judgment, profile),
    usage: Number.isFinite(usage) ? usage : null,
    ...(budget > 0 ? { budget } : {}),
    floor: floorFor(usage, profile),
    qualifies: qualifies(judgment, usage, profile),
  })}\n`;
}

export function errorLogLine(kind: string, body?: string, at = new Date().toISOString()): string {
  return `${JSON.stringify({
    at,
    kind: "error",
    ...(body === undefined ? {} : { id: requestLogId(body) }),
    error: { kind },
  })}\n`;
}
