/** Score a frozen development or holdout partition through production judge/profile code. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { floorFor, JudgeError, qualifies, score } from "../src/judge.ts";
import { parseProfile } from "../src/profile.ts";
import { cachedJudge, replayEndpoint, type ReplayLimits } from "./cached-judge.ts";
import { digest, writePrivate } from "./dataset.ts";
import { judgeKeyFromEnv } from "./key.ts";
import { DECISIONS_MODEL, INVALID_PROVIDER_MESSAGE, selectedProvider } from "../src/decisions.ts";

export interface ExperimentCheckpoint {
  id: string;
  group: string;
  split: "train" | "validation" | "holdout";
  stratum: string;
  state: unknown;
  contextUsage?: number | null;
  usageSource?: string;
}
export interface Selection {
  checkpointHash: string;
  profile: string;
}

export function partition(text: string, split: "development" | "holdout", selection?: Selection): ExperimentCheckpoint[] {
  if (split === "holdout" && selection?.checkpointHash !== digest(text)) {
    throw new Error("Holdout is locked until a selection is frozen against these exact checkpoint bytes.");
  }
  const rows: ExperimentCheckpoint[] = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const ids = new Set<string>();
  const groups = new Map<string, string>();
  for (const row of rows) {
    if (!row.id || ids.has(row.id) || !row.group || !row.stratum || !["train", "validation", "holdout"].includes(row.split)) {
      throw new Error("Checkpoint ids, session groups, strata and split assignments must be frozen and unique.");
    }
    ids.add(row.id);
    if (groups.has(row.group) && groups.get(row.group) !== row.split) {
      throw new Error("A linked session group crosses the experiment split.");
    }
    groups.set(row.group, row.split);
  }
  return rows.filter((row) => split === "holdout" ? row.split === "holdout" : row.split !== "holdout");
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const [checkpointFile, directory, split, limitsFile, profileFile, selectionFile] = process.argv.slice(2).filter((arg) => arg !== "--execute");
  if (!checkpointFile || !directory || !limitsFile || !["development", "holdout"].includes(split ?? "")) {
    throw new Error("Usage: score-profile.ts CHECKPOINTS PRIVATE_DIRECTORY development|holdout LIMITS_JSON [PROFILE_JSON|-] [SELECTION_JSON] [--execute]");
  }
  const text = readFileSync(checkpointFile, "utf8");
  const profileText = profileFile && profileFile !== "-" ? readFileSync(profileFile, "utf8").trim() : "";
  const profile = parseProfile(profileText);
  const selection: Selection | undefined = selectionFile ? JSON.parse(readFileSync(selectionFile, "utf8")) : undefined;
  const rows = partition(text, split as "development" | "holdout", selection);
  if (split === "holdout" && profileText !== "" && profileText !== selection?.profile) {
    throw new Error("Only shipped questions and the frozen candidate may be scored on holdout.");
  }
  const limits: ReplayLimits = JSON.parse(readFileSync(limitsFile, "utf8"));
  const provider = selectedProvider(process.env.COMPACT_ADVISER_PROVIDER);
  if (provider === undefined) throw new Error(INVALID_PROVIDER_MESSAGE);
  if (provider === "openai-decisions" && limits.expectedModel !== DECISIONS_MODEL) throw new Error("Decisions replay requires expectedModel gpt-6-luna.");
  const endpoint = replayEndpoint(limits, provider);
  const outputDirectory = provider === "typesafe" ? directory : join(directory, provider);
  if (!execute) {
    console.log(`Prepared ${rows.length} ${split} rows. No paid calls; pass --execute to score.${provider === "openai-decisions" ? " Provider: openai-decisions (experimental)." : ""}`);
    return;
  }
  const key = judgeKeyFromEnv(provider, endpoint);
  const output = [];
  for (const row of rows) {
    let cached;
    try {
      cached = await cachedJudge(join(outputDirectory, "cache"), row.state, key, limits, profile, undefined, provider);
    } catch (error) {
      if (error instanceof JudgeError && error.kind === "input") {
        output.push({ id: row.id, group: row.group, split: row.split, stratum: row.stratum, ok: false, error: "input", hint: false, auto: false });
        continue;
      }
      throw error;
    }
    if (!cached.ok) {
      output.push({ id: row.id, group: row.group, split: row.split, stratum: row.stratum, ...cached, hint: false, auto: false });
      console.log(`Skipped ${output.length}/${rows.length} after the configured attempt limit.`);
      continue;
    }
    const j = cached.judgment;
    const usage = typeof row.contextUsage === "number" ? row.contextUsage : Number.NaN;
    output.push({
      id: row.id, group: row.group, split: row.split, stratum: row.stratum, ok: true,
      requestHash: cached.requestHash, profileHash: digest(profileText),
      latencyMs: cached.latencyMs, model: j.model, inputTokens: j.inputTokens, outputTokens: j.outputTokens,
      done: j.done.choice, doneP: j.done.probabilities, doneConf: j.done.confidence,
      shape: j.shape.choice, shapeP: j.shape.probabilities, shapeConf: j.shape.confidence,
      score: score(j, profile), usage: Number.isFinite(usage) ? usage : null,
      usageSource: row.usageSource ?? "unavailable; strictest floor",
      floor: floorFor(usage, profile), hint: qualifies(j, usage, profile), auto: qualifies(j, usage, profile),
    });
    console.log(`Scored ${output.length}/${rows.length}; ${j.inputTokens} input tokens; ${cached.latencyMs} ms.`);
  }
  writePrivate(join(outputDirectory, `${split}-${digest(profileText)}.jsonl`), output.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "Replay failed."); process.exitCode = 1; });
}
