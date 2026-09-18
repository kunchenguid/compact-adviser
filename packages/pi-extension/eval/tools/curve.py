#!/usr/bin/env python3
"""Rank quality of a single judge question as a "safe to compact now" score.
usage: curve.py <labels.jsonl> <name>=<probe.jsonl>:<key>:<positive> ...
A probe file is probe-gate.ts output (answers.<key>.probabilities.<positive>) or
score.ts output (key "score" reads the composed score; "done" / "shape" read doneP / shapeP;
legacy "phase" reads phaseP). For each question prints ROC AUC and
average precision against safe_to_compact, then precision/recall at a floor
ladder, so a usage-dependent floor can be read off the same table."""
import json, sys

FLOORS = (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98)

def load(p): return {json.loads(l)["id"]: json.loads(l) for l in open(p) if l.strip()}

def score(row, key, pos):
    if "answers" in row:
        a = row["answers"].get(key)
        return (a.get("probabilities") or {}).get(pos) if a else None
    if key == "score":
        return row.get("score")
    return (row.get(f"{key}P") or {}).get(pos)

def auc(pairs):
    pos = [s for s, y in pairs if y]; neg = [s for s, y in pairs if not y]
    if not pos or not neg: return float("nan")
    wins = sum(1.0 if p > n else 0.5 if p == n else 0.0 for p in pos for n in neg)
    return wins / (len(pos) * len(neg))

def ap(pairs):
    s = sorted(pairs, key=lambda t: -t[0]); npos = sum(1 for _, y in s if y)
    hit = 0; tot = 0.0
    for i, (_, y) in enumerate(s, 1):
        if y: hit += 1; tot += hit / i
    return tot / npos if npos else float("nan")

def pr(pairs, floor):
    tp = sum(1 for s, y in pairs if s >= floor and y); fp = sum(1 for s, y in pairs if s >= floor and not y)
    fn = sum(1 for s, y in pairs if s < floor and y)
    return (tp / (tp + fp) if tp + fp else float("nan")), tp / (tp + fn), tp + fp

def header():
    print(f"{'score':<34}{'AUC':>6}{'AP':>6}  " + "".join(f"{f:>8}" for f in FLOORS))

def line(name, pairs):
    cells = []
    for f in FLOORS:
        p, r, n = pr(pairs, f)
        cells.append(f"{p*100:3.0f}/{r*100:<3.0f}" if p == p else f"  -/{r*100:<3.0f}")
    print(f"{name:<34}{auc(pairs):6.2f}{ap(pairs):6.2f}  " + "".join(f"{c:>8}" for c in cells))

def main():
    L = load(sys.argv[1]); header(); pairs = []
    for spec in sys.argv[2:]:
        name, _, rest = spec.partition("=")
        path, key, pos = rest.split(":")
        P = load(path)
        pairs = [(score(P[i], key, pos), L[i]["safe_to_compact"]) for i in sorted(L) if i in P and P[i].get("ok", True)]
        pairs = [(s, y) for s, y in pairs if s is not None]
        line(name, pairs)
    print(f"rows={len(pairs)} safe={sum(1 for _,y in pairs if y)} base precision={sum(1 for _,y in pairs if y)/len(pairs):.0%}  cells are precision/recall at floor")

if __name__ == "__main__":
    main()
