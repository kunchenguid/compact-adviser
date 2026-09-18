#!/usr/bin/env python3
"""Mine follow-up-after-claimed-complete episodes from real sessions.

For every settled assistant turn (Pi: stopReason=stop; Claude Code: stop_reason=end_turn
with no tool_use) find the first real user turn that follows and look at HOW the assistant
served it: how many tools it called before settling, and how long its settled answer was.
A long zero-tool answer, or a task brief written with no re-read, is the signature of a
follow-up served from older conversation context - the case a compaction would have hurt.

usage: mine_followups.py <harness pi|claude-code> <label> <session.jsonl> [--min-tokens N] [--exclude ids.txt]
Prints one JSON line per candidate episode, highest score first.
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(__file__))
from audit_followups import load_events, BACKREF, WHY, VERDICT, REVISE, CONTINUE, squash  # noqa: E402

DONE = re.compile(r"\b(done|completed?|landed|merged|shipped|filed|pushed|published|wrote|created|"
                  r"report|summary|finished|ready|verified|fixed|closed|resolved|settled)\b", re.I)
BRIEF_TOOL = re.compile(r"tasks-axi (add|create|update)|\.inbox/|brief|\.md['\" ]", re.I)
READ_TOOL = re.compile(r"^(read|grep|glob|rg|cat |sed -n|tail|head|git (log|show|diff)|gh |ls )", re.I)


def usage_index(path, harness):
    """entryId -> context tokens at that assistant record."""
    out = {}
    for line in open(path, errors="replace"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if harness == "claude-code":
            if r.get("type") == "assistant":
                u = (r.get("message") or {}).get("usage") or {}
                out[r.get("uuid")] = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))
        else:
            if r.get("type") == "message" and (r.get("message") or {}).get("role") == "assistant":
                u = (r["message"].get("usage") or {})
                out[r.get("id")] = u.get("totalTokens") or sum(int(u.get(k) or 0) for k in ("input", "output", "cacheRead", "cacheWrite"))
    return out


def main():
    harness, label, path = sys.argv[1:4]
    min_tokens = 40000
    exclude = set()
    args = sys.argv[4:]
    while args:
        a = args.pop(0)
        if a == "--min-tokens":
            min_tokens = int(args.pop(0))
        elif a == "--exclude":
            exclude = {l.strip() for l in open(args.pop(0)) if l.strip()}
    ev = load_events(path, harness)
    usage = usage_index(path, harness)
    settled_idx = [i for i, e in enumerate(ev) if e["kind"] == "assistant" and e["text"].strip() and not e["tools"]
                   and e.get("stop") in ("stop", "end_turn")]
    out = []
    for i in settled_idx:
        cp = ev[i]
        if cp["id"] in exclude:
            continue
        toks = usage.get(cp["id"], 0)
        if toks < min_tokens:
            continue
        # first real user turn after the checkpoint (harness rings skipped, relay rings kept)
        j, comp, skipped = None, False, 0
        for k in range(i + 1, min(i + 40, len(ev))):
            e = ev[k]
            if e["kind"] == "compaction":
                comp = True
            elif e["kind"] == "user":
                if e["harness"]:
                    skipped += 1
                    continue
                j = k
                break
            elif e["kind"] == "assistant" and e["text"].strip() and not e["tools"]:
                break  # another settled turn came first: this checkpoint was superseded
        if j is None:
            continue
        u = ev[j]
        # reply: everything up to the next real user turn
        tools, reply_text, reads_before_brief, brief = [], "", 0, False
        for k in range(j + 1, len(ev)):
            e = ev[k]
            if e["kind"] == "user" and not e["harness"]:
                break
            if e["kind"] == "assistant":
                for name, key, _ in e["tools"]:
                    tools.append(f"{name}:{key[:40]}")
                    if BRIEF_TOOL.search(key) and name in ("bash", "Bash", "write", "Write", "edit", "Edit"):
                        if not brief:
                            brief = True
                            reads_before_brief = sum(1 for t in tools[:-1] if READ_TOOL.search(t.split(":", 1)[1]) or t.split(":")[0].lower() in ("read", "grep", "glob"))
                if e["text"].strip() and not e["tools"]:
                    reply_text = e["text"]
                    break
        ut = u["text"]
        ahoy = "ahoy" in ut[:300].lower()
        score = -3 if ahoy else 0
        if not tools and len(reply_text) >= 400:
            score += 3
        if len(tools) == 1 and len(reply_text) >= 600:
            score += 1
        if brief and reads_before_brief == 0:
            score += 2
        if BACKREF.search(ut):
            score += 2
        if WHY.search(ut):
            score += 1
        if DONE.search(cp["text"][:300]):
            score += 1
        if u.get("relay"):
            score += 1
        out.append({
            "session": label, "harness": harness, "entryId": cp["id"], "tokens": toks, "offset": j - i,
            "harness_skipped": skipped, "compaction_between": comp, "score": score, "ahoy": ahoy,
            "claim": squash(cp["text"], 140), "user": squash(ut, 220),
            "kind": "verdict" if VERDICT.search(ut) else "why" if WHY.search(ut) else "revise" if REVISE.search(ut) else "continue" if CONTINUE.search(ut) else "other",
            "backref": bool(BACKREF.search(ut)), "relay": bool(u.get("relay")),
            "reply_tools": len(tools), "reply_tool_list": tools[:6], "reply_chars": len(reply_text),
            "brief_no_read": brief and reads_before_brief == 0, "reply": squash(reply_text, 200),
        })
    out.sort(key=lambda r: (-r["score"], -r["reply_chars"]))
    for r in out:
        print(json.dumps(r, ensure_ascii=False))
    print(f"# {label}: settled={len(settled_idx)} candidates={len(out)} score>=4: {sum(1 for r in out if r['score']>=4)}", file=sys.stderr)


if __name__ == "__main__":
    main()
