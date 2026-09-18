import { readFileSync } from "node:fs";
import { parseSessionEntries, buildContextEntries } from "@earendil-works/pi-coding-agent";
import { snapshot } from "../src/context.ts";

const sessionFile = process.argv[2];
const logFile = process.argv[3];
if (!sessionFile || !logFile) {
  console.error("usage: node --import tsx eval/fidelity.ts <session.jsonl> <compact-adviser-requests.jsonl>");
  process.exit(1);
}
const entries = parseSessionEntries(readFileSync(sessionFile, "utf8")) as Array<{
  id: string;
  type?: string;
  timestamp?: string;
  message?: { role?: string; stopReason?: string };
}>;
const header = entries.find((e) => e.type === "session") as { cwd?: string } | undefined;
const cwd = header?.cwd ?? process.cwd();

const logged = readFileSync(logFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
console.log(`session entries: ${entries.length} | logged requests: ${logged.length}`);

const settled = entries.filter(
  (e) => e.type === "message" && e.message?.role === "assistant" && e.message?.stopReason === "stop",
);
console.log(`settled assistant checkpoints: ${settled.length}`);

for (const rec of logged) {
    if (rec.body?.state === undefined) continue;
    const want = JSON.stringify(rec.body.state);
  const t = Date.parse(rec.at);
  const near = settled.filter((e) => Math.abs(Date.parse(e.timestamp ?? "") - t) < 5 * 60 * 1000);
  let hit: (typeof settled)[number] | undefined;
  for (const e of near) {
    const ctx = {
      cwd,
      sessionManager: {
        buildContextEntries: () => buildContextEntries(entries as never, e.id),
        getSessionFile: () => sessionFile,
      },
    };
    try {
      if (JSON.stringify(snapshot(ctx as never).state) === want) {
        hit = e;
        break;
      }
    } catch {
      /* skip */
    }
  }
  console.log(
    `${rec.at}  candidates=${String(near.length).padStart(3)}  ${hit ? `EXACT MATCH at entry ${hit.id} (${hit.timestamp})` : "no exact match"}`,
  );
}
