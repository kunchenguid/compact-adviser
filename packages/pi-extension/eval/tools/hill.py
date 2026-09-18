#!/usr/bin/env python3
"""Hill-climb report: AUC / AP / ladder for several probe files that share one
question key, on all rows and on a fixed dev/holdout split (alternate sorted ids).
usage: hill.py <labels.jsonl> <key> <expr> <name>=<probe.jsonl> ...
expr is over p (choice -> prob) for that key, e.g. "p['finished_hands_on']+0.5*p['finished_coordinating']"."""
import json, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from curve import load, auc, ap, pr
L = load(sys.argv[1]); key, expr = sys.argv[2], sys.argv[3]
ids = sorted(L); dev = set(ids[0::2]); hold = set(ids[1::2])
FL = (0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3)
def cells(pairs):
    out = []
    for f in FL:
        p, r, n = pr(pairs, f); out.append(f"{p*100:3.0f}/{r*100:<3.0f}" if p == p else f"  -/{r*100:<3.0f}")
    return " ".join(out)
print(f"{'variant':<14}{'AUC':>5}{'AP':>5} | dev AUC/AP | hold AUC/AP | " + " ".join(f"{f:>7}" for f in FL))
for spec in sys.argv[4:]:
    name, _, path = spec.partition("="); P = load(path)
    S = {i: eval(expr, {}, {"p": P[i]["answers"][key]["probabilities"]}) for i in ids if i in P and P[i].get("ok")}
    pa = [(S[i], L[i]["safe_to_compact"]) for i in S]; pd = [(S[i], L[i]["safe_to_compact"]) for i in S if i in dev]; ph = [(S[i], L[i]["safe_to_compact"]) for i in S if i in hold]
    print(f"{name:<14}{auc(pa):5.2f}{ap(pa):5.2f} |  {auc(pd):.2f}/{ap(pd):.2f}  |  {auc(ph):.2f}/{ap(ph):.2f}  | {cells(pa)}")
