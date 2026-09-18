/**
 * Ask Jev the phase question ALONE and record the answer, to test whether a
 * companion question is load-bearing.
 *   node --import tsx eval/tools/probe-phase-only.ts <dir>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENDPOINT, QUESTIONS } from "../../src/judge.ts";
import { typesafeKeyFromEnv } from "../key.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node --import tsx eval/tools/probe-phase-only.ts <dir>");
  process.exit(1);
}
const key = typesafeKeyFromEnv();
const rows = readFileSync(join(dir, "checkpoints.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const out: unknown[] = [];
let maxBody = 0;
for (const r of rows) {
  const body = JSON.stringify({ model: "jev-latest", state: r.state, questions: { phase: QUESTIONS.phase } });
  maxBody = Math.max(maxBody, Buffer.byteLength(body));
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(60000),
    });
    const j = (await res.json()) as {
      answers?: { phase?: { choice?: string; probabilities?: unknown } };
      model?: string;
    };
    const a = j.answers?.phase;
    out.push({ id: r.id, ok: !!a, phase: a?.choice, phaseP: a?.probabilities, model: j.model });
  } catch (e) {
    out.push({ id: r.id, ok: false, error: String((e as Error).message ?? e) });
  }
}
writeFileSync(join(dir, "phase-only.jsonl"), `${out.map((r) => JSON.stringify(r)).join("\n")}\n`);
console.error(
  `phase-only: ${(out as Array<{ ok?: boolean }>).filter((r) => r.ok).length}/${out.length} ok, max body ${maxBody} bytes`,
);
