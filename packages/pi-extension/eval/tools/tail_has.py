#!/usr/bin/env python3
"""Provenance check: does the judge-visible snapshot (recent tail + user constraints +
previousSummary + savedArtifacts) contain each phrase?  usage: tail_has.py <checkpoints.jsonl> <id> <phrase>..."""
import json, sys
path, cid, *phrases = sys.argv[1:]
row = next(json.loads(l) for l in open(path) if json.loads(l)["id"] == cid)
st = row["state"]
def blob(x): return json.dumps(x, ensure_ascii=False).lower()
parts = {"recent": blob(st.get("recent")), "constraints": blob(st.get("userConstraints")),
         "summary": blob(st.get("previousSummary")), "artifacts": blob(st.get("savedArtifacts"))}
print(f"{cid}: recent={len(st.get('recent') or [])} msgs, stateBytes={row.get('stateBytes')}")
for p in phrases:
    hits = [k for k, v in parts.items() if p.lower() in v]
    print(f"  {'HIT ' if hits else 'miss'} {p!r} -> {hits}")
