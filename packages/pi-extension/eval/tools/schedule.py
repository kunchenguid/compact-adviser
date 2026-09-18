#!/usr/bin/env python3
"""Per-floor outcome table for one score, for reading a usage-dependent floor
schedule off the v4 set. usage: schedule.py <labels.jsonl> <probe.jsonl> <expr> [floor ...] [--origin=<v3|v4-mined>]
expr as in blend.py (a Python expression over p[question][choice]); the probe is
probe-gate.ts output or score.ts output; the gate is score >= floor with no argmax
requirement. --origin keeps only rows with that label origin (v3 = the natural mix). Columns: fires, product precision /
recall (gold safe_to_compact), contract precision / recall (completed+safe vs
still_in_progress), older-context false positives, task-boundary recall."""
import json, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from curve import load
args = [a for a in sys.argv[1:] if not a.startswith("--origin=")]
origin = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--origin=")), None)
L, P = load(args[0]), load(args[1]); expr = args[2]
floors = [float(x) for x in args[3:]] or [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98]
ids = [i for i in sorted(L) if i in P and P[i].get("ok") and (origin is None or L[i].get("origin") == origin)]


def probs(row):
    """p[question][choice] from probe-gate.ts output (answers) or score.ts output (doneP / shapeP)."""
    if "answers" in row:
        return {k: v["probabilities"] for k, v in row["answers"].items()}
    return {k[:-1]: v for k, v in row.items() if k.endswith("P") and isinstance(v, dict)}


S = {i: eval(expr, {}, {"p": probs(P[i])}) for i in ids}
safe = lambda i: L[i]["safe_to_compact"]
yes = [i for i in ids if L[i]["phase_gold"] == "completed_checkpoint" and safe(i)]
no = [i for i in ids if L[i]["phase_gold"] == "still_in_progress"]
older = [i for i in ids if L[i].get("context_need") == "older"]
bnd = [i for i in ids if L[i].get("task_boundary") and safe(i)]
r = lambda a, b: f"{a/b:4.0%}" if b else "   -"
print(f"{'floor':>6} {'fires':>5}  product P/R   contract P/R   older-FP  boundary-R")
for f in floors:
    F = [i for i in ids if S[i] >= f]
    tp = sum(1 for i in F if safe(i)); fp = len(F) - tp; fn = sum(1 for i in ids if S[i] < f and safe(i))
    ctp = sum(1 for i in yes if S[i] >= f); cfp = sum(1 for i in no if S[i] >= f)
    print(f"{f:6.2f} {len(F):5d}  {r(tp,tp+fp)} {r(tp,tp+fn)}    {r(ctp,ctp+cfp)} {r(ctp,len(yes))}   {sum(1 for i in older if S[i]>=f):3d}/{len(older)}    {r(sum(1 for i in bnd if S[i]>=f),len(bnd))}")
