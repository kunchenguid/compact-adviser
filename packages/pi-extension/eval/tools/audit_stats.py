#!/usr/bin/env python3
"""Join v3 gold labels with the follow-up audit labels and print the numbers
the report needs.  usage: audit_stats.py <labels.jsonl> <audit-labels.jsonl> <summary.jsonl>"""
import collections, json, sys

def load(p):
    return {json.loads(l)["id"]: json.loads(l) for l in open(p) if l.strip()}

L, A, S = load(sys.argv[1]), load(sys.argv[2]), load(sys.argv[3])
ids = sorted(L)
obs = [i for i in ids if A[i]["followup_kind"] != "none"]
print(f"rows {len(ids)}  observed-followup {len(obs)}  zero-turn {len(ids)-len(obs)}")

def tab(title, keyf, rows):
    c = collections.Counter(keyf(i) for i in rows)
    print(f"\n== {title} (n={len(rows)})")
    for k, v in sorted(c.items(), key=lambda kv: -kv[1]):
        print(f"  {str(k):<28}{v:>4}")

tab("followup_kind", lambda i: A[i]["followup_kind"], obs)
tab("context_need", lambda i: A[i]["context_need"], obs)
tab("context_need x kind", lambda i: (A[i]["followup_kind"], A[i]["context_need"]), obs)
tab("stratum x context_need", lambda i: (L[i]["sampling"] if "sampling" in L[i] else "?", A[i]["context_need"]), obs)

# stratum names come from checkpoints; summary carries stratum
tab("stratum(summary) x context_need", lambda i: (S[i].get("stratum"), A[i]["context_need"]), obs)

comp = [i for i in obs if L[i]["phase_gold"] == "completed_checkpoint"]
older = [i for i in comp if A[i]["context_need"] == "older"]
print(f"\n== completed_checkpoint rows with an observed follow-up: {len(comp)}; needed OLDER context: {len(older)} ({len(older)/len(comp):.0%})")
print("   older:", older)
prog = [i for i in obs if L[i]["phase_gold"] != "completed_checkpoint"]
print(f"== still_in_progress/unclear rows with an observed follow-up: {len(prog)}; older: {[i for i in prog if A[i]['context_need']=='older']}")

print("\n== flips of safe_to_compact (v3 -> v4)")
for i in ids:
    if bool(L[i]["safe_to_compact"]) != bool(A[i]["safe_v4"]):
        print(f"  {i}: {L[i]['safe_to_compact']} -> {A[i]['safe_v4']}  [{A[i]['followup_kind']}/{A[i]['context_need']}] {A[i]['audit_note'][:90]}")
print("\n== phase_v4 disagreements")
for i in ids:
    pv = A[i].get("phase_v4")
    if pv and pv != L[i]["phase_gold"]:
        print(f"  {i}: {L[i]['phase_gold']} -> {pv}")

def first_user(i):
    nu = S[i].get("next_user")
    if isinstance(nu, list): nu = nu[0] if nu else ""
    return (nu or "") if isinstance(nu, str) else str(nu)
ahoy = [i for i in ids if "ahoy" in first_user(i)[:200].lower()]
print(f"\n== rows whose first real user turn is /ahoy: {len(ahoy)}: {ahoy}")
nat = [i for i in ids if S[i].get("compaction_before_first_real")]
print(f"== natural experiments (compaction before first real turn): {len(nat)}: {nat}")
unsafe = [i for i in ids if not A[i]["safe_v4"]]
print(f"\n== v4 unsafe rows: {len(unsafe)}: {unsafe}")
print(f"== v3 unsafe rows: {[i for i in ids if not L[i]['safe_to_compact']]}")
