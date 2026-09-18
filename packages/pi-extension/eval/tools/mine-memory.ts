/**
 * Sharper miner for genuine older-context dependence: the next user turn asks
 * a back-reference question and the assistant answers it immediately with a
 * settled turn that makes NO tool calls - i.e. it answered from memory.
 */
import { mainBranch } from "../branch.ts";
import { loadCorpus } from "../corpus.ts";
import { loadSession, usageTokens } from "../replay.ts";

const BACKREF =
  /\b(earlier|you said|we discussed|as discussed|remember|originally|last time|previously|why did we|how did we|what was|what did we|did we (ever|already|figure)|i asked|where did we land|whatever happened|what happened to)\b/i;
const text = (c: unknown) =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.filter((x: { type?: string }) => x.type === "text").map((x: { text?: string }) => x.text ?? "").join("\n")
      : "";
const hasToolCall = (c: unknown) => Array.isArray(c) && c.some((x: { type?: string }) => x.type === "toolCall");

const rows: Array<{ session: string; entryId: string; q: string; ans: string }> = [];
for (const cs of loadCorpus()) {
  const s = loadSession(cs.file);
  const branch = mainBranch(s);
  const settled = branch.filter(
    (e) => e.type === "message" && e.message?.role === "assistant" && e.message?.stopReason === "stop",
  );
  for (const e of settled) {
    if (usageTokens(e) < 40000) continue;
    const i = branch.indexOf(e);
    const after = branch.slice(i + 1, i + 6);
    const nu = after.find((f) => f.type === "message" && f.message?.role === "user");
    if (!nu) continue;
    const q = text(nu.message?.content);
    if (!BACKREF.test(q) || q.length > 700) continue;
    const j = branch.indexOf(nu);
    const reply = branch
      .slice(j + 1, j + 3)
      .find((f) => f.type === "message" && f.message?.role === "assistant");
    if (!reply) continue;
    if (reply.message?.stopReason !== "stop" || hasToolCall(reply.message?.content)) continue;
    rows.push({
      session: cs.label,
      entryId: e.id,
      q: q.replace(/\s+/g, " ").slice(0, 150),
      ans: text(reply.message?.content).replace(/\s+/g, " ").slice(0, 200),
    });
  }
}
console.log(`memory-answered back-reference checkpoints: ${rows.length}\n`);
for (const r of rows) console.log(`${r.session} ${r.entryId}\n   Q: ${r.q}\n   A(no tools): ${r.ans}\n`);
