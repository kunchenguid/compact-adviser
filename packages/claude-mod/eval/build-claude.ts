/**
 * Build Claude Code checkpoints + label worksheets.
 *   node --import tsx eval/build-claude.ts <list.tsv> <outDir> <idPrefix> [perSession]
 * list.tsv lines: <label>\t<transcript.jsonl>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  blocks,
  conversation,
  loadTranscript,
  type Rec,
  replayAt,
  settledEntries,
} from "./transcript.ts";

const listFile = process.argv[2];
const outDir = process.argv[3];
const prefix = process.argv[4] ?? "cc";
const perSession = Number(process.argv[5] ?? 6);

/** Evenly spaced picks so a session's whole arc is represented, not just its end. */
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(((i + 0.5) * items.length) / n)]);
  return out;
}

function render(r: Rec, limit: number): string {
  const parts: string[] = [];
  for (const b of blocks(r)) {
    if (b?.type === "text") parts.push(String(b.text ?? "").slice(0, limit));
    else if (b?.type === "tool_use")
      parts.push(`<toolCall ${b.name} ${JSON.stringify(b.input ?? {}).slice(0, 220)}>`);
    else if (b?.type === "tool_result") parts.push("<toolResult>");
    else if (b?.type === "thinking") parts.push("<thinking>");
  }
  const stop = r.message?.stop_reason ? ` stop=${r.message.stop_reason}` : "";
  return `[${r.type}${stop}] ${parts.join(" ").replace(/\n/g, " ").slice(0, limit)}`;
}

mkdirSync(join(outDir, "worksheet"), { recursive: true });
const rows: Record<string, unknown>[] = [];
let id = 0;

for (const spec of readFileSync(listFile, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)) {
  const [label, file] = spec.split("\t");
  if (!existsSync(file)) {
    console.error(`missing ${file}`);
    continue;
  }
  const recs = loadTranscript(file);
  const convo = conversation(recs);
  const settled = settledEntries(recs);
  // Only turns the mod could actually have judged.
  const eligible = settled.filter((e) => replayAt(file, recs, e, 0) !== null);
  const picks = spread(eligible, perSession);
  const seen = new Set<string>();
  let built = 0;
  for (const e of picks) {
    const cp = replayAt(file, recs, e, settled.indexOf(e));
    if (!cp) continue;
    if (seen.has(cp.checkpointKey)) continue;
    seen.add(cp.checkpointKey);
    const rid = `${prefix}${String(++id).padStart(3, "0")}`;
    rows.push({ id: rid, session: label, harness: "claude-code", ...cp });

    const st = cp.state;
    const at = convo.findIndex((x) => x.uuid === e.uuid);
    const future = at >= 0 ? convo.slice(at + 1, at + 9) : [];
    writeFileSync(
      join(outDir, "worksheet", `${rid}.md`),
      [
        `# ${rid}  (${label})  settled ${settled.indexOf(e) + 1}/${settled.length}`,
        ``,
        `contextTokens=${cp.contextTokens} conversationTokens=${cp.conversationTokens} stateBytes=${cp.stateBytes} messages=${cp.messageCount}`,
        `coverage=${JSON.stringify(st.coverage)}`,
        `savedArtifacts=${JSON.stringify(st.savedArtifacts)}`,
        ``,
        `## A. What the judge sees - user constraints`,
        ...st.userConstraints.slice(-4).map((m) => `- ${m.text.slice(0, 600).replace(/\n/g, " ")}`),
        ``,
        `## B. What the judge sees - tail of recent`,
        ...st.recent
          .slice(-10)
          .map(
            (m) =>
              `- [${m.role}] ${m.text.slice(0, 700).replace(/\n/g, " ")}${
                m.tools?.length
                  ? ` {tools: ${m.tools.map((t) => `${t.tool}${t.error ? "!" : ""}`).join(",")}}`
                  : ""
              }`,
          ),
        ``,
        `## C. FUTURE - labelling evidence only, never sent to the judge`,
        ...future.map((f) => `- ${render(f, 700)}`),
        ``,
        `## D. Labels`,
        `phase_gold: `,
        `continuation_gold: `,
        `safe_to_compact: `,
        `pivot: `,
        `task_boundary: `,
        `note: `,
        ``,
      ].join("\n"),
    );
    built++;
  }
  console.error(
    `${label.padEnd(26)} settled=${String(settled.length).padStart(4)} eligible=${String(eligible.length).padStart(4)} built=${built}`,
  );
}
writeFileSync(
  join(outDir, "checkpoints.jsonl"),
  `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
);
console.error(`\nwrote ${rows.length} claude checkpoints -> ${outDir}`);
