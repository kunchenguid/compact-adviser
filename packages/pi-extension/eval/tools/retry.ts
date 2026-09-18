/**
 * Retry a single failed checkpoint score and patch results.jsonl in place.
 *   node --import tsx eval/tools/retry.ts <dataDir> <id>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { floorFor, judge, qualifies, score } from "../../src/judge.ts";
import { continuationOf } from "../continuation.ts";
import { openrouterKeyFromEnv } from "../key.ts";

const [dir, id, usageArg] = process.argv.slice(2);
const usage = Number(usageArg ?? 0.5);
if (!dir || !id) {
  console.error("usage: node --import tsx eval/tools/retry.ts <dataDir> <id> [usage]");
  process.exit(1);
}
const key = openrouterKeyFromEnv();
const cps = readFileSync(join(dir, "checkpoints.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const r = cps.find((c: { id: string }) => c.id === id);
if (!r) {
  console.error(`${id}: not found`);
  process.exit(1);
}
for (let a = 0; a < 3; a++) {
  try {
    const j = await judge(r.state, key, new AbortController().signal, fetch, 60000);
    const cont = continuationOf(j);
    console.error(
      `attempt ${a}: OK ${j.done.choice}/${j.shape.choice}${cont ? `/${cont.choice}` : ""} score=${score(j).toFixed(2)} hint=${qualifies(j, usage)}`,
    );
    const rows = readFileSync(join(dir, "results.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const i = rows.findIndex((x: { id: string }) => x.id === id);
    const row = {
      id,
      rep: 0,
      ok: true,
      latencyMs: 0,
      model: j.model,
      inputTokens: j.inputTokens,
      outputTokens: j.outputTokens,
      done: j.done.choice,
      doneP: j.done.probabilities,
      doneConf: j.done.confidence,
      shape: j.shape.choice,
      shapeP: j.shape.probabilities,
      shapeConf: j.shape.confidence,
      score: score(j),
      usage,
      floor: floorFor(usage),
      ...(cont
        ? {
            continuation: cont.choice,
            continuationP: cont.probabilities,
            continuationConf: cont.confidence,
          }
        : {}),
      hint: qualifies(j, usage),
      auto: qualifies(j, usage),
      retried: true,
    };
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    writeFileSync(join(dir, "results.jsonl"), `${rows.map((x: unknown) => JSON.stringify(x)).join("\n")}\n`);
    process.exit(0);
  } catch (e) {
    console.error(`attempt ${a}: FAILED ${(e as { kind?: string; message?: string }).kind ?? (e as Error).message}`);
  }
}
process.exit(1);
