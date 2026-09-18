#!/usr/bin/env python3
"""Compare two or more results jsonl files against the same gold labels."""
import json
import sys


def load(path):
    return {json.loads(l)["id"]: json.loads(l) for l in open(path) if l.strip()}


if len(sys.argv) < 5:
    sys.exit("usage: compare.py <labels.jsonl> <checkpoints.jsonl> <name> <results.jsonl> [<name> <results.jsonl>...]")

L = load(sys.argv[1])
C = load(sys.argv[2])
runs = [(n, load(p)) for n, p in zip(sys.argv[3::2], sys.argv[4::2])]


def should_hint(i):
    phase_ok = L[i]["phase_gold"] == "completed_checkpoint"
    if "continuation_gold" not in L[i]:
        return phase_ok
    return phase_ok and L[i]["continuation_gold"] == "recoverable"


gold = {i: should_hint(i) for i in L}
print(f"{'metric':<34}" + "".join(f"{n:>14}" for n, _ in runs))


def row(label, fn):
    print(f"{label:<34}" + "".join(f"{fn(r):>14}" for _, r in runs))


def ok_values(r):
    return [x for x in r.values() if x.get("ok")]


row("hint fires", lambda r: sum(x["hint"] for x in ok_values(r)))
row("auto fires", lambda r: sum(x["auto"] for x in ok_values(r)))


def completed(x):
    return x.get("phase", {"finished": "completed_checkpoint"}.get(x.get("done"))) == "completed_checkpoint"


def strength(x):
    return x["score"] if "score" in x else x["phaseP"]["completed_checkpoint"]


row("phase=completed", lambda r: sum(completed(x) for x in ok_values(r)))
row("max score", lambda r: f"{max(strength(x) for x in ok_values(r)):.2f}")
row(
    "median score",
    lambda r: f"{sorted(strength(x) for x in ok_values(r))[len(ok_values(r))//2]:.2f}",
)
if all("continuation" in x for x in ok_values(runs[0][1])):
    row("continuation=recoverable", lambda r: sum(x.get("continuation") == "recoverable" for x in ok_values(r)))
    row("continuation=unclear", lambda r: sum(x.get("continuation") == "unclear" for x in ok_values(r)))
    row(
        "continuation=needs_older",
        lambda r: sum(x.get("continuation") == "needs_older_details" for x in ok_values(r)),
    )


def cm(r, k):
    tp = fp = fn = 0
    for i, x in r.items():
        if not x.get("ok"):
            continue
        f, g = x["hint"], gold[i]
        if f and g:
            tp += 1
        elif f and not g:
            fp += 1
        elif not f and g:
            fn += 1
    return {"TP": tp, "FP": fp, "FN": fn}[k]


for k in ("TP", "FP", "FN"):
    row(f"{k} vs gold should-hint", lambda r, k=k: cm(r, k))
row(
    "phase agreement",
    lambda r: sum(1 for i, x in r.items() if x.get("ok") and completed(x) == (L[i]["phase_gold"] == "completed_checkpoint")),
)
print()
for n, r in runs:
    fires = [i for i, x in r.items() if x.get("ok") and x["hint"]]
    if fires:
        print(
            f"{n} fires on: "
            + ", ".join(f"{i}({'GOOD' if gold[i] else 'BAD'},{C[i].get('stratum', '?')})" for i in sorted(fires))
        )
