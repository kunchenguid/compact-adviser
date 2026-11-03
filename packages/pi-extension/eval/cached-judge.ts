/** Durable, request-byte keyed replay through the production judge. Never stores the key. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { judge, type Judgment, requestBody } from "../src/judge.ts";
import { DECISIONS_MODEL, type JudgeProvider } from "../src/decisions.ts";
import type { JudgeProfile } from "../src/profile.ts";
import { digest, privateOutput, writePrivate } from "./dataset.ts";

export interface ReplayLimits {
  expectedModel: string;
  maxCalls: number;
  maxInputTokens: number;
  maxEstimatedUsd: number;
  inputUsdPerMillion: number;
  failedCallEstimateUsd: number;
}
interface Success {
  ok: true;
  requestHash: string;
  judgment: Judgment;
  latencyMs: number;
}
interface Failure {
  ok: false;
  requestHash: string;
  error: string;
  latencyMs: number;
}
export type CachedJudgment = Success | Failure;
type Capture = (text: string, truncated: boolean) => void;
export type Evaluate = (state: unknown, key: string, profile?: JudgeProfile, capture?: Capture) => Promise<Judgment>;
interface Accounting {
  estimated: true;
  costUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
  basis: string;
}
function read<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** The capture is bounded and stores no headers. Oversized replies retain a marker, not a secret prefix. */
export async function productionEvaluate(
  state: unknown, key: string, profile?: JudgeProfile, capture?: Capture, network: typeof fetch = fetch,
  provider: JudgeProvider = "typesafe",
): Promise<Judgment> {
  return judge(state, key, new AbortController().signal, async (url, init) => {
    const response = await network(url, init);
    const reader = response.clone().body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 32768) { truncated = true; break; }
          chunks.push(next.value);
        }
      } finally {
        // Awaiting cancellation of one tee branch can wait for the other branch forever.
        void reader.cancel().catch(() => {});
      }
      const text = truncated ? "[response exceeded capture limit]" : Buffer.concat(chunks).toString("utf8");
      const escapedKey = JSON.stringify(key).slice(1, -1);
      capture?.(text.replaceAll(key, "[REDACTED]").replaceAll(escapedKey, "[REDACTED]"), truncated);
    }
    return response;
  }, 60000, profile, undefined, provider);
}

function attempts(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((hash) => /^[a-f0-9]{64}$/.test(hash))
    .flatMap((hash) => [join(directory, hash), join(directory, hash, "retry")])
    .filter((root) => existsSync(join(root, "started.json")));
}
function accounting(root: string, result: CachedJudgment, limits: ReplayLimits): Accounting {
  if (!result.ok && !existsSync(join(root, "accounting.json"))) {
    throw new Error("Failed call lacks an explicit accounting estimate; reconcile before continuing.");
  }
  const value: Accounting = result.ok ? {
    estimated: true, costUsd: result.judgment.inputTokens * limits.inputUsdPerMillion / 1e6,
    inputTokens: result.judgment.inputTokens, outputTokens: result.judgment.outputTokens,
    basis: "input-price proxy; output tariff unavailable",
  } : read<Accounting>(join(root, "accounting.json"));
  if (value.estimated !== true || !Number.isFinite(value.costUsd) || value.costUsd < 0 ||
    [value.inputTokens, value.outputTokens].some((tokens) =>
      tokens === null ? result.ok : !Number.isSafeInteger(tokens) || tokens < 0)) {
    throw new Error("Invalid call accounting record; reconcile before continuing.");
  }
  return value;
}

export function cacheUsage(directory: string, limits: ReplayLimits): { calls: number; inputTokens: number; outputTokens: number; unknownUsageCalls: number; estimatedUsd: number } {
  const total = { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0, estimatedUsd: 0 };
  for (const root of attempts(directory)) {
    total.calls++;
    if (!existsSync(join(root, "result.json"))) {
      throw new Error("Incomplete Jev call: reconcile saved response before continuing.");
    }
    const result = read<CachedJudgment>(join(root, "result.json"));
    if (result.ok && result.judgment.model !== limits.expectedModel) {
      throw new Error("Jev model identity changed in this ledger; a new comparison decision is required.");
    }
    const cost = accounting(root, result, limits);
    total.inputTokens += cost.inputTokens ?? 0;
    total.outputTokens += cost.outputTokens ?? 0;
    total.unknownUsageCalls += cost.inputTokens === null || cost.outputTokens === null ? 1 : 0;
    total.estimatedUsd += cost.costUsd;
  }
  return total;
}

function failureAccounting(raw: string | undefined, limits: ReplayLimits): Accounting {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  try {
    const usage = JSON.parse(raw ?? "null")?.usage;
    if (Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0 &&
      Number.isSafeInteger(usage?.output_tokens) && usage.output_tokens >= 0) {
      inputTokens = usage.input_tokens;
      outputTokens = usage.output_tokens;
    }
  } catch { /* Keep unknown usage explicit. */ }
  return {
    estimated: true,
    costUsd: Math.max(limits.failedCallEstimateUsd, (inputTokens ?? 0) * limits.inputUsdPerMillion / 1e6),
    inputTokens, outputTokens,
    basis: inputTokens === null ? "explicit failed-call allowance; token usage unknown" : "failed-call allowance with recovered response usage",
  };
}

export async function cachedJudge(
  directory: string, state: unknown, key: string, limits: ReplayLimits,
  profile?: JudgeProfile, transport?: Evaluate, provider: JudgeProvider = "typesafe",
): Promise<CachedJudgment> {
  if (provider === "openai-decisions" && limits.expectedModel !== DECISIONS_MODEL) throw new Error("Decisions replay requires expectedModel gpt-6-luna.");
  const evaluate = transport ?? ((state, key, profile, capture) => productionEvaluate(state, key, profile, capture, fetch, provider));
  if (!key.trim() || !limits.expectedModel || !Number.isSafeInteger(limits.maxCalls) || limits.maxCalls < 1 ||
    !Number.isSafeInteger(limits.maxInputTokens) || limits.maxInputTokens < 1 ||
    ![limits.maxEstimatedUsd, limits.inputUsdPerMillion, limits.failedCallEstimateUsd].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Replay requires a key, model identity, and positive call/token/cost limits.");
  }
  const body = requestBody(state, profile, provider);
  const requestHash = digest(body);
  const base = join(directory, digest(`${limits.expectedModel}\n${body}`));
  let last: CachedJudgment | undefined;
  for (const root of [base, join(base, "retry")]) {
    privateOutput(join(root, "result.json"));
    const saved = join(root, "result.json");
    if (existsSync(saved)) {
      last = read<CachedJudgment>(saved);
      if (last.requestHash !== requestHash || readFileSync(join(root, "request.json"), "utf8") !== body) {
        throw new Error("Cached Jev request failed identity checks; do not silently rescore it.");
      }
      accounting(root, last, limits);
      if (last.ok) {
        if (last.judgment.model !== limits.expectedModel) throw new Error("Jev model identity changed.");
        return last;
      }
      continue;
    }
    const usage = cacheUsage(directory, limits);
    if (usage.calls >= limits.maxCalls || usage.inputTokens >= limits.maxInputTokens ||
      usage.estimatedUsd + limits.failedCallEstimateUsd > limits.maxEstimatedUsd) {
      throw new Error("Jev replay reached its approved call/token/cost ceiling.");
    }
    writePrivate(join(root, "request.json"), body);
    writePrivate(join(root, "started.json"), JSON.stringify({ requestHash, at: new Date().toISOString() }));
    const started = Date.now();
    let raw: string | undefined;
    try {
      const judgment = await evaluate(state, key, profile, (text, truncated) => {
        raw = text;
        writePrivate(join(root, "response.json"), JSON.stringify({ text, truncated }));
      });
      last = { ok: true, requestHash, judgment, latencyMs: Date.now() - started };
    } catch (error) {
      const kind = (error as { kind?: unknown })?.kind;
      const safeKind = typeof kind === "string" && ["timeout", "network", "authentication", "rate-limit", "server", "response", "input"].includes(kind) ? kind : "unavailable";
      last = { ok: false, requestHash, error: safeKind, latencyMs: Date.now() - started };
      writePrivate(join(root, "accounting.json"), JSON.stringify(failureAccounting(raw, limits)));
    }
    writePrivate(saved, JSON.stringify(last));
    if (!last.ok) {
      const recorded = cacheUsage(directory, limits);
      if (recorded.inputTokens > limits.maxInputTokens || recorded.estimatedUsd > limits.maxEstimatedUsd) {
        throw new Error("Jev ceiling exceeded by the failed call. Stop before further scoring.");
      }
    }
    if (last.ok) {
      if (last.judgment.model !== limits.expectedModel) throw new Error("Jev model identity changed.");
      if (usage.inputTokens + last.judgment.inputTokens > limits.maxInputTokens ||
        usage.estimatedUsd + last.judgment.inputTokens * limits.inputUsdPerMillion / 1e6 > limits.maxEstimatedUsd) {
        throw new Error("Jev ceiling exceeded by the completed call. Stop before further scoring.");
      }
      return last;
    }
  }
  // Two failed attempts remain an observed no-hint outcome, never an invented judgment.
  if (!last) throw new Error("Missing replay outcome.");
  return last;
}
