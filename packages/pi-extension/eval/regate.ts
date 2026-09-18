/**
 * Re-derive the product decision from an existing results file using the
 * SHIPPED qualifies(), so a gate change is measured without model jitter.
 *   node --import tsx eval/regate.ts <in-results.jsonl> <out-results.jsonl>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { qualifies, type Judgment } from "../src/judge.ts";

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error("usage: node --import tsx eval/regate.ts <in-results.jsonl> <out-results.jsonl>");
  process.exit(1);
}
const rows = readFileSync(inPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
let flips = 0;
for (const r of rows) {
  if (!r.ok) continue;
  const j = {
    phase: { choice: r.phase, probabilities: r.phaseP, confidence: r.phaseConf },
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
  } as Judgment;
  const hint = qualifies(j),
    auto = qualifies(j);
  if (hint !== r.hint) flips++;
  r.hint = hint;
  r.auto = auto;
}
writeFileSync(outPath, `${rows.map((r: unknown) => JSON.stringify(r)).join("\n")}\n`);
console.error(`regated ${rows.length} rows, ${flips} hint decisions changed -> ${outPath}`);
