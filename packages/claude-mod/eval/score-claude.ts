/**
 * Score Claude Code checkpoints against live TypeSafe Jev through the shipped
 * claude-mod judge() and qualifies().
 *   TYPESAFE_API_KEY=... node --import tsx eval/score-claude.ts <dataDir> [repeats]
 * The key is read from the environment only and is never printed or stored.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { floorFor, type Judgment, judge, qualifies, score } from "../lib/judge.ts";

const dir = process.argv[2];
const repeats = Number(process.argv[3] ?? 1);
const key = process.env.TYPESAFE_API_KEY?.trim();
if (!key) {
  console.error("TYPESAFE_API_KEY missing");
  process.exit(1);
}

/** The host injects `$.http.fetch` and `$.clock.sleep`; offline we use the platform's. */
const transport = {
  fetch: async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => {
    const r = await fetch(url, init);
    return { status: r.status, ok: r.ok, text: await r.text() };
  },
  // Production races a 2000ms timeout; a slow call here is measured, not counted as failure.
  sleep: (_ms: number) => new Promise<void>((resolve) => setTimeout(resolve, 60000)),
};

const rows = readFileSync(join(dir, "checkpoints.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const out: Record<string, unknown>[] = [];
for (const r of rows) {
  for (let rep = 0; rep < repeats; rep++) {
    const t0 = Date.now();
    try {
      const j: Judgment = await judge(r.state, key, transport);
      out.push({
        id: r.id,
        rep,
        ok: true,
        latencyMs: Date.now() - t0,
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
        usage: 0.5,
        floor: floorFor(0.5),
        hint: qualifies(j, 0.5),
        auto: qualifies(j, 0.5),
      });
      console.error(
        `${r.id} r${rep} ${String(Date.now() - t0).padStart(5)}ms ${j.done.choice}/${j.shape.choice} score=${score(j).toFixed(2)} hint=${qualifies(j, 0.5)}`,
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
const ok = out.filter((r) => r.ok);
console.error(`\nwrote ${out.length} results (${ok.length} ok) -> ${join(dir, "results.jsonl")}`);
if (ok.length) {
  const lat = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];
  console.error(
    `latency ms: min=${lat[0]} p50=${pct(50)} p90=${pct(90)} max=${lat.at(-1)} | over 2000ms: ${lat.filter((x) => x > 2000).length}/${lat.length}`,
  );
}
