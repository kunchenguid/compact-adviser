/**
 * Ask Jev ONE shipped question alone (default `done`) and record the answer, to
 * test whether the companion question changes it.
 *   node --import tsx eval/tools/probe-phase-only.ts <dir> [done|shape]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENDPOINT, QUESTIONS } from "../../src/judge.ts";
import { openrouterKeyFromEnv } from "../key.ts";

const dir = process.argv[2];
const which = (process.argv[3] ?? "done") as keyof typeof QUESTIONS;
if (!dir || !(which in QUESTIONS)) {
  console.error("usage: node --import tsx eval/tools/probe-phase-only.ts <dir> [done|shape]");
  process.exit(1);
}
const key = openrouterKeyFromEnv();
const rows = readFileSync(join(dir, "checkpoints.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const out: unknown[] = [];
let maxBody = 0;
for (const r of rows) {
  const body = JSON.stringify({ model: "typesafe/jev-1.13", state: r.state, questions: { [which]: QUESTIONS[which] } });
  maxBody = Math.max(maxBody, Buffer.byteLength(body));
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(60000),
    });
    const j = (await res.json()) as {
      answers?: Record<string, { choice?: string; probabilities?: unknown } | undefined>;
      model?: string;
    };
    const a = j.answers?.[which];
    out.push({ id: r.id, ok: !!a, question: which, choice: a?.choice, probabilities: a?.probabilities, model: j.model });
  } catch (e) {
    out.push({ id: r.id, ok: false, error: String((e as Error).message ?? e) });
  }
}
writeFileSync(join(dir, `${which}-only.jsonl`), `${out.map((r) => JSON.stringify(r)).join("\n")}\n`);
console.error(
  `${which}-only: ${(out as Array<{ ok?: boolean }>).filter((r) => r.ok).length}/${out.length} ok, max body ${maxBody} bytes`,
);
