import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { floorFor, JudgeError, type Judgment, qualifies, score } from "./judge.ts";

import type { JudgeProfile } from "./profile.ts";

export const REQUEST_LOG_NAME = "compact-adviser-requests.jsonl";

export function requestLogPath(agentDir: string): string {
  return join(agentDir, REQUEST_LOG_NAME);
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
  profile?: JudgeProfile,
  /** The context budget the usage is measured against; recorded only when one is set. */
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

function writeLog(agentDir: string, line: string): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  appendFileSync(requestLogPath(agentDir), line, { mode: 0o600 });
}

export function appendRequestLog(agentDir: string, body: string): void {
  writeLog(agentDir, requestLogLine(body));
}

export function appendResponseLog(
  agentDir: string,
  body: string,
  judgment: Judgment,
  usage: number,
  profile?: JudgeProfile,
  budget = 0,
): void {
  writeLog(agentDir, responseLogLine(body, judgment, usage, undefined, profile, budget));
}

export function appendErrorLog(agentDir: string, error: unknown, body?: string): void {
  writeLog(agentDir, errorLogLine(loggedJudgeErrorKind(error), body));
}
