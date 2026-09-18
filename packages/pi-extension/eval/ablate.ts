/**
 * Diagnostic ablation: which snapshot coverage flags move the judgment?
 * Sends coverage-flag variants of a few checkpoints. Diagnostic only - it does
 * not change production behaviour and its variants are not real session state.
 *   node --import tsx eval/ablate.ts <dataDir> <id...>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judge, score } from "../src/judge.ts";
import { continuationOf } from "./continuation.ts";
import { openrouterKeyFromEnv } from "./key.ts";

const dir = process.argv[2];
const ids = process.argv.slice(3);
if (!dir || ids.length === 0) {
  console.error("usage: node --import tsx eval/ablate.ts <dataDir> <id...>");
  process.exit(1);
}
const key = openrouterKeyFromEnv();
const rows = readFileSync(join(dir, "checkpoints.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

type Coverage = Record<string, unknown>;
const variants: Record<string, (c: Coverage) => Coverage> = {
  base: (c) => c,
  clean_all: (c) => ({
    ...c,
    omittedUserMessages: 0,
    olderMessagesOmitted: 0,
    recentTextTruncated: false,
    hasImages: false,
    redacted: false,
    unknownContext: false,
  }),
  no_omitted_users: (c) => ({ ...c, omittedUserMessages: 0 }),
  no_older: (c) => ({ ...c, olderMessagesOmitted: 0 }),
  no_unknown: (c) => ({ ...c, unknownContext: false }),
  no_trunc: (c) => ({ ...c, recentTextTruncated: false }),
};

const out: unknown[] = [];
for (const id of ids) {
  const r = rows.find((x: { id: string }) => x.id === id);
  if (!r) {
    console.error(`${id}: not found`);
    continue;
  }
  for (const [name, fn] of Object.entries(variants)) {
    const state = { ...r.state, coverage: fn(r.state.coverage) };
    try {
      const j = await judge(state, key, new AbortController().signal, fetch, 60000);
      const cont = continuationOf(j);
      out.push({
        id,
        variant: name,
        done: j.done.choice,
        shape: j.shape.choice,
        score: score(j),
        ...(cont
          ? { continuation: cont.choice, recovP: cont.probabilities.recoverable }
          : {}),
      });
      const contPart = cont
        ? `  cont=${cont.choice.padEnd(12)} P(recoverable)=${(cont.probabilities.recoverable ?? Number.NaN).toFixed(2)}`
        : "";
      console.error(
        `${id} ${name.padEnd(17)} done=${j.done.choice.padEnd(12)} shape=${j.shape.choice.padEnd(12)} score=${score(j).toFixed(2)}${contPart}`,
      );
    } catch (e) {
      console.error(`${id} ${name} FAILED ${(e as { kind?: string }).kind}`);
    }
  }
  console.error("");
}
writeFileSync(join(dir, "ablation.jsonl"), `${out.map((r) => JSON.stringify(r)).join("\n")}\n`);
