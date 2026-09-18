/**
 * Score the checkpoint dataset against live TypeSafe Jev using the shipped
 * judge() and qualifies(). Writes one result row per checkpoint.
 *   node --import tsx eval/score.ts <dataDir> [repeats]
 * The key is read from the environment only and is never printed or stored.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judge, qualifies, type Judgment } from "../src/judge.ts";
import { continuationOf } from "./continuation.ts";
import { typesafeKeyFromEnv } from "./key.ts";

const dir = process.argv[2];
const repeats = Number(process.argv[3] ?? 1);
if (!dir) {
  console.error("usage: node --import tsx eval/score.ts <dataDir> [repeats]");
  process.exit(1);
}
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
      });
      console.error(
        `${r.id} r${rep} ${String(latencyMs).padStart(5)}ms ${j.phase.choice} hint=${qualifies(j)}`,
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
