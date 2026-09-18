/**
 * Mine candidate checkpoints whose FOLLOWING work looks dependent on older
 * context, or whose phase looks genuinely ambiguous. Cheap: raw entries only,
 * no snapshot() call. Output is a ranked candidate list for human labelling -
 * the signals are search heuristics, never gold labels.
 */
import { mainBranch } from "../branch.ts";
import { type CorpusEntry, loadCorpus } from "../corpus.ts";
import { loadSession, usageTokens } from "../replay.ts";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: { type?: string }) => c.type === "text")
    .map((c: { text?: string }) => c.text ?? "")
    .join("\n");
}

/** Phrases where the speaker reaches back to something said earlier in the session. */
const BACKREF =
  /\b(earlier|you said|we discussed|as discussed|as we|remember|originally|last time|previously|before that|the one (you|we)|that thing|why did we|how did we|what was|what did we|did we (do|ever|already)|i asked|i already|same as|like we|back then|the first one|revert to|go back)\b/i;
const RECAP = /(?:^|\s)\/(?:recap|summary|compact)\b|# (?:recap|summary)/i;

export interface Candidate {
  session: string;
  stratum: string;
  entryId: string;
  timestamp: string;
  ordinal: number;
  contextTokens: number;
  score: number;
  signals: string[];
  nextUserExcerpt: string;
}

export function mine(corpus: CorpusEntry[] = loadCorpus()): Candidate[] {
  const out: Candidate[] = [];
  for (const c of corpus) {
    const s = loadSession(c.file);
    const branch = mainBranch(s);
    const settled = branch.filter(
      (e) => e.type === "message" && e.message?.role === "assistant" && e.message?.stopReason === "stop",
    );
    for (const e of settled) {
      const tok = usageTokens(e);
      if (tok < 40000) continue;
      const i = branch.indexOf(e);
      const future = branch.slice(i + 1, i + 16);
      const signals: string[] = [];
      let score = 0;

      const nextUser = future.find((f) => f.type === "message" && f.message?.role === "user");
      const nextUserText = nextUser ? textOf(nextUser.message?.content) : "";
      if (BACKREF.test(nextUserText)) {
        signals.push("user-backref");
        score += 3;
      }
      if (RECAP.test(nextUserText)) {
        signals.push("recap-command");
        score += 2;
      }

      const futureAsst = future
        .filter((f) => f.type === "message" && f.message?.role === "assistant")
        .map((f) => textOf(f.message?.content))
        .join("\n");
      if (BACKREF.test(futureAsst)) {
        signals.push("assistant-backref");
        score += 1;
      }

      const own = textOf(e.message?.content).trim();
      if (own.length < 60) {
        signals.push("terse-checkpoint");
        score += 1;
      }
      const errs = future.filter(
        (f) => f.type === "message" && f.message?.role === "toolResult" && (f as { message?: { isError?: boolean } }).message?.isError,
      ).length;
      if (errs >= 2) {
        signals.push(`post-errors:${errs}`);
        score += 1;
      }
      if (
        future.some(
          (f) =>
            f.type === "message" && f.message?.role === "assistant" && f.message?.stopReason === "error",
        )
      ) {
        signals.push("post-error-stop");
        score += 1;
      }

      if (score >= 2)
        out.push({
          session: c.label,
          stratum: c.stratum,
          entryId: e.id,
          timestamp: e.timestamp ?? "",
          ordinal: settled.indexOf(e),
          contextTokens: tok,
          score,
          signals,
          nextUserExcerpt: nextUserText.slice(0, 180).replace(/\s+/g, " "),
        });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

if (process.argv[1]?.endsWith("mine.ts")) {
  const c = mine();
  const bySig: Record<string, number> = {};
  for (const x of c) for (const s of x.signals) bySig[s.split(":")[0]] = (bySig[s.split(":")[0]] ?? 0) + 1;
  console.log(`candidates with score>=2: ${c.length}`);
  console.log("signal counts:", bySig);
  console.log(
    "\nby stratum:",
    c.reduce((a: Record<string, number>, x) => ({ ...a, [x.stratum]: (a[x.stratum] ?? 0) + 1 }), {}),
  );
  console.log("\ntop 25:");
  for (const x of c.slice(0, 25))
    console.log(
      `  ${x.session.padEnd(15)} ${x.entryId} s=${x.score} [${x.signals.join(",")}]  "${x.nextUserExcerpt.slice(0, 95)}"`,
    );
}
