#!/usr/bin/env python3
"""Sweep a hint gate offline over a probe-gate.ts output.
usage: gate_sweep.py <labels.jsonl> <checkpoints.jsonl> <probe.jsonl> <gate-spec>...
gate-spec: key=positive[@floor]  joined with '+' for a conjunction, e.g.
  phase=completed_checkpoint@0.9            (shipped gate)
  prior_context=self_contained@0.8
  phase=completed_checkpoint@0.9+prior_context=self_contained@0.7
With no floor the script sweeps floors 0.5..0.98 for that term (other terms fixed)."""
import json, sys

def load(p): return {json.loads(l)["id"]: json.loads(l) for l in open(p) if l.strip()}
L, C, P = load(sys.argv[1]), load(sys.argv[2]), load(sys.argv[3])
ids = sorted(i for i in P if P[i].get("ok") and i in L)

def term(spec):
    kv, _, floor = spec.partition("@")
    k, pos = kv.split("=")
    return k, pos, (float(floor) if floor else None)

def fires(i, terms):
    for k, pos, fl in terms:
        a = P[i]["answers"].get(k)
        if not a or a.get("choice") != pos or (a.get("probabilities") or {}).get(pos, 0) < fl:
            return False
    return True

def report(name, terms):
    safe = lambda i: L[i]["safe_to_compact"]
    tp = sum(1 for i in ids if fires(i, terms) and safe(i)); fp = sum(1 for i in ids if fires(i, terms) and not safe(i))
    fn = sum(1 for i in ids if not fires(i, terms) and safe(i))
    yes = [i for i in ids if L[i]["phase_gold"] == "completed_checkpoint" and safe(i)]
    no = [i for i in ids if L[i]["phase_gold"] == "still_in_progress"]
    ctp = sum(1 for i in yes if fires(i, terms)); cfp = sum(1 for i in no if fires(i, terms))
    older = [i for i in ids if L[i].get("context_need") == "older"]
    older_fp = sum(1 for i in older if fires(i, terms))
    bnd = [i for i in ids if L[i].get("task_boundary") and safe(i)]
    bhit = sum(1 for i in bnd if fires(i, terms))
    r = lambda a, b: f"{a/b:.0%}" if b else "-"
    print(f"{name:<52} fires={tp+fp:>3} product P={r(tp,tp+fp):>4} R={r(tp,tp+fn):>4} | contract P={r(ctp,ctp+cfp):>4} R={r(ctp,len(yes)):>4} | older-FP {older_fp}/{len(older)} | boundary R {bhit}/{len(bnd)}")

for spec in sys.argv[4:]:
    terms = [term(s) for s in spec.split("+")]
    if all(fl is not None for _, _, fl in terms):
        report(spec, terms); continue
    for f in (0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98):
        t2 = [(k, pos, fl if fl is not None else f) for k, pos, fl in terms]
        report(f"{spec} @{f}", t2)
