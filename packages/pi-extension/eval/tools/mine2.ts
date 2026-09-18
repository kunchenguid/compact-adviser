import { mine } from "./mine.ts";

const all = mine();
const isRecap = (c: { signals: string[] }) => c.signals.includes("recap-command");
const backrefOnly = all.filter((c) => !isRecap(c) && c.signals.includes("user-backref"));
const errs = all.filter((c) => c.signals.some((s) => s.startsWith("post-error")));
const terse = all.filter((c) => c.signals.includes("terse-checkpoint") && !isRecap(c));
console.log(
  `non-recap user-backref: ${backrefOnly.length} | post-error: ${errs.length} | terse non-recap: ${terse.length} | recap: ${all.filter(isRecap).length}`,
);
console.log("\n--- non-recap user-backref candidates (the real memory probes) ---");
for (const c of backrefOnly.slice(0, 32))
  console.log(
    `${c.session.padEnd(15)} ${c.entryId} ${c.stratum.padEnd(8)} s=${c.score} "${c.nextUserExcerpt.slice(0, 130)}"`,
  );
console.log("\n--- post-error candidates (phase ambiguity) ---");
for (const c of errs.slice(0, 10))
  console.log(
    `${c.session.padEnd(15)} ${c.entryId} ${c.stratum.padEnd(8)} [${c.signals.join(",")}] "${c.nextUserExcerpt.slice(0, 90)}"`,
  );
