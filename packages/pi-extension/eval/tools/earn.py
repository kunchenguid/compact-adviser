#!/usr/bin/env python3
"""Does an addition earn its place? Paired bootstrap over rows of the AP and AUC
difference between each candidate and a base, for one score expression.
usage: earn.py <labels.jsonl> <key> <expr> <base>=<probe.jsonl> <cand>=<probe.jsonl> ... [--n 2000]"""
import json, sys, random
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from curve import load, auc, ap
args = [a for a in sys.argv[1:] if not a.startswith("--n")]; n = int(next((a[3:] for a in sys.argv if a.startswith("--n")), 2000))
L = load(args[0]); key, expr = args[1], args[2]
def scores(path):
    P = load(path); return {i: eval(expr, {}, {"p": P[i]["answers"][key]["probabilities"]}) for i in sorted(L) if i in P and P[i].get("ok")}
bname, _, bpath = args[3].partition("="); B = scores(bpath); ids = sorted(B)
y = {i: L[i]["safe_to_compact"] for i in ids}
random.seed(7); boots = [[random.choice(ids) for _ in ids] for _ in range(n)]
pb = [(B[i], y[i]) for i in ids]
print(f"base {bname}: AP {ap(pb):.3f} AUC {auc(pb):.3f}  (n={n} paired bootstrap resamples)")
print(f"{'candidate':<14}{'AP':>7}{'dAP':>8}{'P(dAP>0)':>10}{'AUC':>7}{'dAUC':>8}{'P(dAUC>0)':>11}")
for spec in args[4:]:
    name, _, path = spec.partition("="); C = scores(path)
    pc = [(C[i], y[i]) for i in ids]
    dap = ap(pc) - ap(pb); dauc = auc(pc) - auc(pb)
    wa = wu = 0
    for bs in boots:
        a1 = ap([(C[i], y[i]) for i in bs]) - ap([(B[i], y[i]) for i in bs]); u1 = auc([(C[i], y[i]) for i in bs]) - auc([(B[i], y[i]) for i in bs])
        wa += a1 > 0; wu += u1 > 0
    print(f"{name:<14}{ap(pc):7.3f}{dap:+8.3f}{wa/n:10.2f}{auc(pc):7.3f}{dauc:+8.3f}{wu/n:11.2f}")
