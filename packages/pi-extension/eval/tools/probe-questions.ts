/**
 * Score the corpus with an ARBITRARY questions block (e.g. a historical
 * contract) so older question text stays comparable after the shipped one moves.
 *   node --import tsx eval/tools/probe-questions.ts <dir> <questions.json> <out.jsonl> [gate]
 * gate: "conjunction" (both >= 0.90) or "phase" (phase >= 0.90). Default phase.
 * Historical: this expects a `phase` answer (completed_checkpoint / still_in_progress /
 * unclear); for the shipped two-question contract use eval/score.ts or probe-gate.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ENDPOINT } from "../../src/judge.ts";
import { openrouterKeyFromEnv } from "../key.ts";

const [dir, qpath, out, gate = "phase"] = process.argv.slice(2);
if (!dir || !qpath || !out) {
  console.error(
    "usage: node --import tsx eval/tools/probe-questions.ts <dir> <questions.json> <out.jsonl> [phase|conjunction]",
  );
  process.exit(1);
}
const key = openrouterKeyFromEnv();
const questions = JSON.parse(readFileSync(qpath, "utf8"));
const rows = readFileSync(`${dir}/checkpoints.jsonl`, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const res: unknown[] = [];
for (const r of rows) {
  const body = JSON.stringify({ model: "typesafe/jev-1.13", state: r.state, questions });
  try {
    const rsp = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(60000),
    });
    const j = (await rsp.json()) as {
      answers?: {
        phase?: { choice?: string; probabilities?: { completed_checkpoint?: number } };
        continuation?: { choice?: string; probabilities?: { recoverable?: number } };
      };
      model?: string;
    };
    const p = j.answers?.phase,
      c = j.answers?.continuation;
    if (!p) {
      res.push({ id: r.id, ok: false, error: "no phase" });
      continue;
    }
    const pc = p.probabilities?.completed_checkpoint ?? 0;
    const rc = c?.probabilities?.recoverable ?? 1;
    const ok90 = p.choice === "completed_checkpoint" && pc >= 0.9;
    const hint = gate === "phase" ? ok90 : ok90 && c?.choice === "recoverable" && rc >= 0.9;
    const auto =
      gate === "phase"
        ? p.choice === "completed_checkpoint" && pc >= 0.98
        : p.choice === "completed_checkpoint" && pc >= 0.98 && c?.choice === "recoverable" && rc >= 0.98;
    res.push({
      id: r.id,
      rep: 0,
      ok: true,
      model: j.model,
      phase: p.choice,
      phaseP: p.probabilities,
      ...(c ? { continuation: c.choice, continuationP: c.probabilities } : {}),
      hint,
      auto,
    });
  } catch (e) {
    res.push({ id: r.id, ok: false, error: String((e as Error).message ?? e) });
  }
}
writeFileSync(out, `${res.map((r) => JSON.stringify(r)).join("\n")}\n`);
console.error(`${(res as Array<{ ok?: boolean }>).filter((r) => r.ok).length}/${res.length} ok -> ${out}`);
