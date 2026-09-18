#!/usr/bin/env python3
"""Score gold labels against a results jsonl from eval/score.ts."""
import collections
import json
import sys


def load(path):
    rows = {}
    for line in open(path):
        if not line.strip():
            continue
        row = json.loads(line)
        rows[row["id"]] = row
    return rows


if len(sys.argv) < 4:
    sys.exit("usage: metrics.py <labels.jsonl> <checkpoints.jsonl> <results.jsonl>")

L, C, raw = load(sys.argv[1]), load(sys.argv[2]), load(sys.argv[3])
R = {i: raw[i] for i in raw if raw[i].get("ok")}
ids = sorted(R)
print(f"scored {len(ids)} checkpoints | model {set(R[i]['model'] for i in ids)}\n")


def per_class(field, gold_field, classes):
    if any(gold_field not in L[i] for i in ids) or any(field not in R[i] for i in ids):
        print(f"=== {field} skipped (missing on this labels/results pair) ===\n")
        return
    print(f"=== {field} per-class precision / recall ===")
    print(f"{'class':<24}{'gold n':>7}{'pred n':>7}{'TP':>5}{'prec':>8}{'recall':>8}{'F1':>7}")
    for c in classes:
        tp = sum(1 for i in ids if R[i][field] == c and L[i][gold_field] == c)
        pred = sum(1 for i in ids if R[i][field] == c)
        gn = sum(1 for i in ids if L[i][gold_field] == c)
        p = tp / pred if pred else None
        r = tp / gn if gn else None
        f1 = (2 * p * r / (p + r)) if (p and r) else None
        fmt = lambda x: f"{x:.0%}" if x is not None else "  -"
        print(f"{c:<24}{gn:>7}{pred:>7}{tp:>5}{fmt(p):>8}{fmt(r):>8}{fmt(f1):>7}")
    agree = sum(1 for i in ids if R[i][field] == L[i][gold_field])
    print(f"overall agreement: {agree}/{len(ids)} = {agree/len(ids):.0%}\n")
    print("confusion (gold -> jev):")
    cm = collections.Counter((L[i][gold_field], R[i][field]) for i in ids)
    for k, v in sorted(cm.items()):
        print(f"   {k[0]:<22} -> {k[1]:<22} {v}")
    print()


per_class("phase", "phase_gold", ["completed_checkpoint", "still_in_progress", "unclear"])
per_class("continuation", "continuation_gold", ["recoverable", "needs_older_details", "unclear"])

print("=== binary view: phase completed vs NOT ===")
tp = sum(1 for i in ids if R[i]["phase"] == "completed_checkpoint" and L[i]["phase_gold"] == "completed_checkpoint")
fp = sum(1 for i in ids if R[i]["phase"] == "completed_checkpoint" and L[i]["phase_gold"] != "completed_checkpoint")
fn = sum(1 for i in ids if R[i]["phase"] != "completed_checkpoint" and L[i]["phase_gold"] == "completed_checkpoint")
tn = sum(1 for i in ids if R[i]["phase"] != "completed_checkpoint" and L[i]["phase_gold"] != "completed_checkpoint")
print(f"  TP={tp} FP={fp} FN={fn} TN={tn}   precision={tp/(tp+fp):.0%} recall={tp/(tp+fn):.0%}\n")

has_cont = all("continuation" in R[i] for i in ids) and all("continuation_gold" in L[i] for i in ids)
if has_cont:
    print("=== binary view: continuation recoverable vs NOT ===")
    tp = sum(1 for i in ids if R[i]["continuation"] == "recoverable" and L[i]["continuation_gold"] == "recoverable")
    fp = sum(1 for i in ids if R[i]["continuation"] == "recoverable" and L[i]["continuation_gold"] != "recoverable")
    fn = sum(1 for i in ids if R[i]["continuation"] != "recoverable" and L[i]["continuation_gold"] == "recoverable")
    tn = sum(1 for i in ids if R[i]["continuation"] != "recoverable" and L[i]["continuation_gold"] != "recoverable")
    print(f"  TP={tp} FP={fp} FN={fn} TN={tn}   precision={tp/(tp+fp):.0%} recall={tp/(tp+fn):.0%}")
    print(f"  specificity on non-recoverable (correct abstentions): {tn}/{tn+fp} = {tn/(tn+fp):.0%}\n")


def gold_should_hint(i):
    phase_ok = L[i]["phase_gold"] == "completed_checkpoint"
    if "continuation_gold" not in L[i]:
        return phase_ok
    return phase_ok and L[i]["continuation_gold"] == "recoverable"


print("=== product hint (qualifies) vs gold should-hint ===")
gold = {i: gold_should_hint(i) for i in ids}
tp = sum(1 for i in ids if R[i]["hint"] and gold[i])
fp = sum(1 for i in ids if R[i]["hint"] and not gold[i])
fn = sum(1 for i in ids if not R[i]["hint"] and gold[i])
tn = sum(1 for i in ids if not R[i]["hint"] and not gold[i])
print(f"  gold should-hint: {sum(gold.values())}/{len(ids)}")
print(f"  TP={tp} FP={fp} FN={fn} TN={tn}  precision={(f'{tp/(tp+fp):.0%}' if tp+fp else '-')} recall={tp/(tp+fn):.0%}")
print(f"  fires: {[i for i in ids if R[i]['hint']]}")
print(f"  auto fires: {sum(R[i]['auto'] for i in ids)}")
print()

if all("safe_to_compact" in L[i] for i in ids):
    print("=== product hint vs hindsight safe_to_compact ===")
    tp = sum(1 for i in ids if R[i]["hint"] and L[i]["safe_to_compact"])
    fp = sum(1 for i in ids if R[i]["hint"] and not L[i]["safe_to_compact"])
    fn = sum(1 for i in ids if not R[i]["hint"] and L[i]["safe_to_compact"])
    tn = sum(1 for i in ids if not R[i]["hint"] and not L[i]["safe_to_compact"])
    print(f"  TP={tp} FP={fp} FN={fn} TN={tn}  precision={(f'{tp/(tp+fp):.0%}' if tp+fp else '-')} recall={(f'{tp/(tp+fn):.0%}' if tp+fn else '-')}")
    print()

print("=== by sampling arm (targeted arm is enriched, not a natural prior) ===")
for arm in ("spread", "targeted-hard"):
    sub = [i for i in ids if C[i].get("sampling", "spread") == arm]
    if not sub:
        continue
    ph = sum(1 for i in sub if R[i]["phase"] == L[i]["phase_gold"])
    line = f"  {arm:<14} n={len(sub):3d}  phase {ph}/{len(sub)}"
    if has_cont:
        co = sum(1 for i in sub if R[i]["continuation"] == L[i]["continuation_gold"])
        nonrec = [i for i in sub if L[i]["continuation_gold"] != "recoverable"]
        caught = sum(1 for i in nonrec if R[i]["continuation"] != "recoverable")
        line += f"  continuation {co}/{len(sub)}  non-recoverable caught {caught}/{len(nonrec)}"
    print(line)


# --- The two gold definitions, reported side by side -------------------------
# They disagree, and the disagreement is the finding. `product` asks the
# hindsight question (would compacting here have cost anything); `contract`
# asks the judge's own question (was the assistant's unit finished), and it is
# the only definition with a real negative class on the coding strata.


def rate(n, d):
    return f"{n/d:.0%}" if d else "-"


def product_truth(sub):
    """Gold is safe_to_compact. A hint at a harmless moment counts."""
    tp = sum(1 for i in sub if R[i]["hint"] and L[i]["safe_to_compact"])
    fp = sum(1 for i in sub if R[i]["hint"] and not L[i]["safe_to_compact"])
    fn = sum(1 for i in sub if not R[i]["hint"] and L[i]["safe_to_compact"])
    auto = sum(1 for i in sub if R[i]["auto"])
    return tp, fp, rate(tp, tp + fp), rate(tp, tp + fn), auto


def contract(sub):
    """Should-hint is completed+safe; should-NOT-hint is still_in_progress."""
    yes = [i for i in sub if L[i]["phase_gold"] == "completed_checkpoint" and L[i]["safe_to_compact"]]
    no = [i for i in sub if L[i]["phase_gold"] == "still_in_progress"]
    tp = sum(1 for i in yes if R[i]["hint"])
    fp = sum(1 for i in no if R[i]["hint"])
    tn = len(no) - fp
    return tp, fp, tn, rate(tp, tp + fp), rate(tp, len(yes)), len(yes), len(no)


strata = sorted({C[i].get("stratum", "?") for i in ids})
groups = [("ALL", ids)] + [(s, [i for i in ids if C[i].get("stratum") == s]) for s in strata]

if all("safe_to_compact" in L[i] for i in ids):
    print("=== product truth: gold is safe_to_compact ===")
    print(f"{'set':<22}{'n':>5}{'TP':>5}{'FP':>5}{'prec':>7}{'recall':>8}{'auto':>6}")
    for name, sub in groups:
        if not sub:
            continue
        tp, fp, prec, rec, auto = product_truth(sub)
        print(f"{name:<22}{len(sub):>5}{tp:>5}{fp:>5}{prec:>7}{rec:>8}{auto:>6}")
    print()

    print("=== contract: should-hint = completed + safe; should-NOT = still_in_progress ===")
    print(f"{'set':<22}{'n':>5}{'TP':>5}{'FP':>5}{'TN':>5}{'prec':>7}{'recall':>8}{'+n':>4}{'-n':>4}")
    for name, sub in groups:
        if not sub:
            continue
        tp, fp, tn, prec, rec, yes, no = contract(sub)
        print(f"{name:<22}{len(sub):>5}{tp:>5}{fp:>5}{tn:>5}{prec:>7}{rec:>8}{yes:>4}{no:>4}")
    print()

# --- Task-boundary recall, a first-class metric -----------------------------
# A checkpoint the product exists to catch: the moment one task ends and the
# next begins. Recall here is reported separately because a judge can look
# healthy overall while missing exactly these.

if all("task_boundary" in L[i] for i in ids):
    print("=== task-boundary recall (the moments the product exists to catch) ===")
    print(f"{'gold':<16}{'boundary':>18}{'non-boundary':>18}")
    for gold_name, positive in (
        ("product truth", lambda i: L[i]["safe_to_compact"]),
        ("contract", lambda i: L[i]["phase_gold"] == "completed_checkpoint" and L[i]["safe_to_compact"]),
    ):
        cells = []
        for want_boundary in (True, False):
            sub = [i for i in ids if bool(L[i]["task_boundary"]) is want_boundary and positive(i)]
            hit = sum(1 for i in sub if R[i]["hint"])
            cells.append(f"{hit}/{len(sub)} = {rate(hit, len(sub))}")
        print(f"{gold_name:<16}{cells[0]:>18}{cells[1]:>18}")
    print()
else:
    print("=== task-boundary recall skipped (no task_boundary on these labels) ===\n")
