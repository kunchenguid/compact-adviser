/**
 * Retry a single failed checkpoint score and patch results.jsonl in place.
 *   node --import tsx eval/retry.ts <dataDir> <id>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judge, qualifies } from "../src/judge.ts";
import { continuationOf } from "./continuation.ts";
import { typesafeKeyFromEnv } from "./key.ts";

const [dir, id] = process.argv.slice(2);
if (!dir || !id) {
  console.error("usage: node --import tsx eval/retry.ts <dataDir> <id>");
  process.exit(1);
}
const key = typesafeKeyFromEnv();
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
      `attempt ${a}: OK ${j.phase.choice}${cont ? `/${cont.choice}` : ""} hint=${qualifies(j)} pP=${JSON.stringify(j.phase.probabilities)}`,
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
      phase: j.phase.choice,
      phaseP: j.phase.probabilities,
      phaseConf: j.phase.confidence,
      ...(cont
        ? {
            continuation: cont.choice,
            continuationP: cont.probabilities,
            continuationConf: cont.confidence,
          }
        : {}),
      hint: qualifies(j),
      auto: qualifies(j),
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
