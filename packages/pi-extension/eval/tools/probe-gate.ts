/**
 * Measurement-only probe: send an arbitrary questions block (optionally merged
 * with the shipped questions) and keep every answer so gates can be swept
 * offline with eval/tools/gate_sweep.py, curve.py, blend.py and schedule.py.
 *   node --import tsx eval/tools/probe-gate.ts <dir> <questions.json> <out.jsonl> [--with-shipped]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ENDPOINT, QUESTIONS } from "../../src/judge.ts";
import { typesafeKeyFromEnv } from "../key.ts";

const [dir, qpath, out, flag] = process.argv.slice(2);
if (!dir || !qpath || !out) {
  console.error("usage: node --import tsx eval/tools/probe-gate.ts <dir> <questions.json> <out.jsonl> [--with-shipped]");
  process.exit(1);
}
const key = typesafeKeyFromEnv();
const extra = JSON.parse(readFileSync(qpath, "utf8"));
const questions = flag === "--with-shipped" ? { ...QUESTIONS, ...extra } : extra;
const rows = readFileSync(`${dir}/checkpoints.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const res: unknown[] = [];
let n = 0;
for (const r of rows) {
  const t0 = Date.now();
  try {
    const rsp = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "jev-latest", state: r.state, questions }),
      signal: AbortSignal.timeout(60000),
    });
    const j = (await rsp.json()) as { answers?: Record<string, { choice?: string; probabilities?: Record<string, number> }>; model?: string; usage?: unknown };
    if (!j.answers) throw new Error(`no answers: ${JSON.stringify(j).slice(0, 200)}`);
    res.push({ id: r.id, ok: true, latencyMs: Date.now() - t0, model: j.model, usage: j.usage, answers: j.answers });
  } catch (e) {
    res.push({ id: r.id, ok: false, error: String((e as Error).message ?? e) });
  }
  if (++n % 20 === 0) console.error(`${n}/${rows.length}`);
}
writeFileSync(out, `${res.map((r) => JSON.stringify(r)).join("\n")}\n`);
console.error(`${(res as Array<{ ok?: boolean }>).filter((r) => r.ok).length}/${res.length} ok -> ${out}`);
