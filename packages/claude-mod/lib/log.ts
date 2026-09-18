import { floorFor, JudgeError, type Judgment, qualifies, score } from "./judge.ts";

export const REQUEST_LOG_NAME = "compact-adviser-requests.jsonl";

export function requestLogPath(home: string): string {
  const root = home.replace(/[\\/]+$/, "");
  return `${root}/.claude/${REQUEST_LOG_NAME}`;
}

/** Stable correlation id for a request body. FNV-1a 64 so Claude Code hooks need no Node crypto. */
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
): string {
  return `${JSON.stringify({
    at,
    kind: "response",
    id: requestLogId(body),
    answers: {
      done: { choice: judgment.done.choice, probabilities: judgment.done.probabilities },
      shape: { choice: judgment.shape.choice, probabilities: judgment.shape.probabilities },
    },
    score: score(judgment),
    usage: Number.isFinite(usage) ? usage : null,
    floor: floorFor(usage),
    qualifies: qualifies(judgment, usage),
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
