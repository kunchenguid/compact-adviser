/**
 * Score the checkpoint dataset against live TypeSafe Jev using the shipped
 * judge(), score() and qualifies(). Writes one result row per checkpoint with
 * both answers and the composed score; `hint` / `auto` are the gate at a
 * reference context usage (default 0.5, floor 0.70), and metrics.py can
 * re-gate from `score` at any floor.
 *   node --import tsx eval/score.ts <dataDir> [repeats] [usage]
 * The key is read from the environment only and is never printed or stored.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { floorFor, judge, type Judgment, qualifies, score } from "../src/judge.ts";
import { continuationOf } from "./continuation.ts";
import { typesafeKeyFromEnv } from "./key.ts";

const dir = process.argv[2];
const repeats = Number(process.argv[3] ?? 1);
const usage = Number(process.argv[4] ?? 0.5);
if (!dir) {
  console.error("usage: node --import tsx eval/score.ts <dataDir> [repeats] [usage]");
  process.exit(1);
}
console.error(`gate: score >= ${floorFor(usage)} (context usage ${usage})`);
const key = typesafeKeyFromEnv();

const rows = readFileSync(join(dir, "checkpoints.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const out: unknown[] = [];
for (const r of rows) {
  for (let rep = 0; rep < repeats; rep++) {
    const t0 = Date.now();
    try {
      const j: Judgment = await judge(r.state, key, new AbortController().signal, fetch, 60000);
      const latencyMs = Date.now() - t0;
      const cont = continuationOf(j);
      out.push({
        id: r.id,
        rep,
        ok: true,
        latencyMs,
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
      });
      console.error(
        `${r.id} r${rep} ${String(latencyMs).padStart(5)}ms ${j.done.choice}/${j.shape.choice} score=${score(j).toFixed(2)} hint=${qualifies(j, usage)}`,
      );
    } catch (e) {
      const err = e as { kind?: string; message?: string };
      out.push({
        id: r.id,
        rep,
        ok: false,
        latencyMs: Date.now() - t0,
        error: err?.kind ?? String(err?.message ?? e),
      });
      console.error(`${r.id} r${rep} FAILED ${err?.kind ?? err?.message}`);
    }
  }
}
writeFileSync(join(dir, "results.jsonl"), `${out.map((r) => JSON.stringify(r)).join("\n")}\n`);
const okRows = out.filter((r) => (r as { ok?: boolean }).ok) as Array<{ latencyMs: number }>;
console.error(`\nwrote ${out.length} results (${okRows.length} ok) -> ${join(dir, "results.jsonl")}`);
if (okRows.length) {
  const lat = okRows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];
  console.error(
    `latency ms: min=${lat[0]} p50=${pct(50)} p90=${pct(90)} max=${lat.at(-1)} | over 2000ms (production timeout): ${lat.filter((x) => x > 2000).length}/${lat.length}`,
  );
}
