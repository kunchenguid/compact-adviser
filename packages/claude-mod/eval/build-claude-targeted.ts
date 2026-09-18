/**
 * Targeted Claude Code checkpoints: explicit <label>\t<transcript>\t<uuid> picks.
 *   node --import tsx eval/build-claude-targeted.ts <picks.tsv> <outDir> <idPrefix> <startIndex>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTranscript, type Rec, replayAt, settledEntries } from "./transcript.ts";

const [picksFile, outDir, prefix, startIdx] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const rows: Record<string, unknown>[] = [];
let id = Number(startIdx ?? 0);
const cache = new Map<string, Rec[]>();
for (const spec of readFileSync(picksFile, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)) {
  const [label, file, uuid] = spec.split("\t");
  if (!existsSync(file)) {
    console.error(`missing ${file}`);
    continue;
  }
  const recs = cache.get(file) ?? loadTranscript(file);
  cache.set(file, recs);
  const settled = settledEntries(recs);
  const e = settled.find((r) => r.uuid === uuid);
  if (!e) {
    console.error(`skip ${label}:${uuid} - not a settled entry`);
    continue;
  }
  const cp = replayAt(file, recs, e, settled.indexOf(e));
  if (!cp) {
    console.error(`skip ${label}:${uuid} - fails size gates`);
    continue;
  }
  const rid = `${prefix}${String(++id).padStart(3, "0")}`;
  rows.push({
    id: rid,
    session: label,
    stratum: "claude-supervision",
    harness: "claude-code",
    sampling: "targeted-hard",
    ...cp,
  });
  console.error(
    `${rid} ${label} ${uuid.slice(0, 8)} ctx=${cp.contextTokens} conv=${cp.conversationTokens} bytes=${cp.stateBytes}`,
  );
}
writeFileSync(
  join(outDir, "checkpoints-extension.jsonl"),
  `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
);
console.error(`\nwrote ${rows.length} claude checkpoints -> ${outDir}`);
