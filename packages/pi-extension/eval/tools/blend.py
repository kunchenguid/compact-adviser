#!/usr/bin/env python3
"""Offline: turn one probe's probability vectors into a single score and print its
curve. usage: blend.py <labels.jsonl> <probe.jsonl> <name>=<expr> ...
expr is a Python expression over p (question -> choice -> prob), e.g.
  "p['compact_now']['drop_safe'] + 0.5*p['compact_now']['finished_history_bound']"
  "p['phase']['completed_checkpoint'] * p['session_shape']['hands_on_work']" """
import json, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from curve import load, header, line

def main():
    L, P = load(sys.argv[1]), load(sys.argv[2]); header()
    for spec in sys.argv[3:]:
        name, _, expr = spec.partition("=")
        pairs = []
        for i in sorted(L):
            if i not in P or not P[i].get("ok"): continue
            p = {k: v["probabilities"] for k, v in P[i]["answers"].items()}
            pairs.append((eval(expr, {}, {"p": p}), L[i]["safe_to_compact"]))
        line(name, pairs)

if __name__ == "__main__":
    main()
