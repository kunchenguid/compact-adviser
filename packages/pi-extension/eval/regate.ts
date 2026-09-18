/**
 * Re-derive the product decision from an existing results file using the
 * SHIPPED score() and qualifies(), so a gate change is measured without model
 * jitter. The results must carry both answers (doneP, shapeP).
 *   node --import tsx eval/regate.ts <in-results.jsonl> <out-results.jsonl> [usage]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { floorFor, type Judgment, qualifies, score } from "../src/judge.ts";

const [inPath, outPath, usageArg] = process.argv.slice(2);
const usage = Number(usageArg ?? 0.5);
if (!inPath || !outPath) {
  console.error(
    "usage: node --import tsx eval/regate.ts <in-results.jsonl> <out-results.jsonl> [usage]",
  );
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
    done: { choice: r.done, probabilities: r.doneP, confidence: r.doneConf },
    shape: { choice: r.shape, probabilities: r.shapeP, confidence: r.shapeConf },
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
  } as Judgment;
  const hint = qualifies(j, usage),
    auto = qualifies(j, usage);
  if (hint !== r.hint) flips++;
  r.score = score(j);
  r.usage = usage;
  r.floor = floorFor(usage);
  r.hint = hint;
  r.auto = auto;
}
writeFileSync(outPath, `${rows.map((r: unknown) => JSON.stringify(r)).join("\n")}\n`);
console.error(`regated ${rows.length} rows, ${flips} hint decisions changed -> ${outPath}`);
