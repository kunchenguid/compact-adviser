#!/usr/bin/env python3
"""Render what the user actually did after each checkpoint.

For every row in a checkpoints.jsonl (Pi or Claude Code), walk the transcript
forward from the checkpoint and print the next real user turns with the
assistant's reply to each: tool calls made, and the settled text. Harness
injections (watcher wakes, system reminders, review-round prompts) are shown
as one-line markers so a relayed decision is still visible but never mistaken
for a person typing.

  python3 eval/tools/audit_followups.py <checkpoints.jsonl> <labels.jsonl> <outDir> [maxUserTurns]

Writes <outDir>/<id>.md per row and <outDir>/summary.jsonl with heuristic
signals. The signals are search aids for a human labeller, never labels.
"""
import collections
import json
import os
import re
import sys

PI_HARNESS = (
    "FIRSTMATE_OP",
    "<system-reminder>",
    "Caveat: The messages below",
    "This session is being continued from",
    "FIRSTMATE WATCHER WAKE",
    "Workspace boundary (important)",
    "[fm-from-firstmate]",
    "<task-notification>",
    "Firstmate instruction waiting",
    "<user-prompt-submit-hook>",
)
CC_HARNESS = PI_HARNESS + ("<local-command", "<command-name>", "<command-message>")

BACKREF = re.compile(
    r"\b(earlier|you said|we discussed|as discussed|remember|originally|last time|previously|"
    r"why did (we|you)|how did (we|you)|what was|what did we|did we (ever|already|figure|not)|i asked|"
    r"where did we land|whatever happened|what happened to|the (earlier|previous|old) (fix|change|approach|version)|"
    r"why (is|was|are|do|does|did) (it|this|that|we|you)|what does (that|this|it) mean|the one (you|we))\b",
    re.I,
)
WHY = re.compile(r"\b(why|how come|what('s| is) the (reason|point)|explain)\b", re.I)
VERDICT = re.compile(
    r"^\s*(ok(ay)?[,.]?\s*)?(let'?s|lets|go with|do|pick|choose|take|i('ll| will) (go|take)|option|yes[, ]|"
    r"approved?|ship it|proceed|sounds good|b\b|a\b|c\b|d\b|\d\b)",
    re.I,
)
OPTION_TOKEN = re.compile(r"\b(option\s*[a-d1-4]|[a-d]\+[a-d]|\b[A-D]\b)\b")
REVISE = re.compile(
    r"\b(instead|rather|change (it|that|this)|actually|also|but|can (we|you) (also|instead|make)|"
    r"what about|not quite|wrong|doesn't|does not|should (be|have)|revert|undo|tweak|adjust|fix)\b",
    re.I,
)
CONTINUE = re.compile(r"\b(continue|go ahead|next|carry on|keep going|proceed|resume|and then)\b", re.I)


def text_of_pi(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")


def tools_of_pi(content, results=None):
    out = []
    if isinstance(content, list):
        for p in content:
            if isinstance(p, dict) and p.get("type") == "toolCall":
                a = p.get("arguments") or {}
                key = a.get("path") or a.get("command") or a.get("pattern") or a.get("url") or ""
                res = (results or {}).get(p.get("id"), "")
                out.append((p.get("name", "?"), str(key)[:90].replace("\n", " "), res))
    return out


RELAY = ("Firstmate instruction waiting", "[fm-from-firstmate]")


def is_harness(text, harness):
    head = text[:600]
    return any(h in head for h in harness)


def is_relay(text):
    """A ring that tells the worker to read an instruction file: the instruction
    itself (often a relayed captain decision) arrives through a tool result."""
    return any(r in text[:600] for r in RELAY)


INBOX_KEY = re.compile(r"\.msg|inbox|\.inbox", re.I)


def squash(s, n):
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[:n] + f" …(+{len(s) - n})"


# --------------------------------------------------------------------------
# Pi: entries on the main branch (leaf -> root parent chain).


def pi_main_branch(entries):
    by_id = {e.get("id"): e for e in entries if e.get("id")}
    parents = {e.get("parentId") for e in entries if e.get("parentId")}
    leaf = None
    for e in reversed(entries):
        if e.get("id") and e["id"] not in parents:
            leaf = e
            break
    if leaf is None:
        leaf = entries[-1]
    chain, seen = [], set()
    cur = leaf
    while cur and cur.get("id") not in seen:
        seen.add(cur["id"])
        chain.append(cur)
        cur = by_id.get(cur.get("parentId"))
    chain.reverse()
    return chain


def pi_events(branch):
    """Flatten to a uniform event list: user | assistant | toolResult | compaction | other."""
    ev = []
    results = {}
    for e in branch:
        if e.get("type") == "message" and (e.get("message") or {}).get("role") == "toolResult":
            m = e["message"]
            results[m.get("toolCallId")] = text_of_pi(m.get("content"))
    for e in branch:
        t = e.get("type")
        if t == "compaction":
            ev.append({"kind": "compaction", "id": e.get("id")})
            continue
        if t != "message":
            if t in ("custom_message",):
                ev.append({"kind": "harness", "id": e.get("id"), "text": squash(str(e.get("content", "")), 160), "tag": t})
            continue
        m = e.get("message") or {}
        role = m.get("role")
        if role == "user":
            txt = text_of_pi(m.get("content"))
            ev.append({"kind": "user", "id": e.get("id"), "text": txt, "harness": is_harness(txt, PI_HARNESS) and not is_relay(txt), "relay": is_relay(txt)})
        elif role == "assistant":
            ev.append(
                {
                    "kind": "assistant",
                    "id": e.get("id"),
                    "text": text_of_pi(m.get("content")),
                    "tools": tools_of_pi(m.get("content"), results),
                    "stop": m.get("stopReason"),
                }
            )
        elif role == "toolResult":
            ev.append({"kind": "toolResult", "id": e.get("id"), "error": bool(m.get("isError"))})
    return ev


# --------------------------------------------------------------------------
# Claude Code: records on the parent chain of the LAST record (main thread).


def cc_blocks(r):
    c = (r.get("message") or {}).get("content")
    if isinstance(c, str):
        return [{"type": "text", "text": c}]
    return c if isinstance(c, list) else []


def cc_chain(by, leaf):
    chain, seen = [], set()
    cur = leaf
    while cur and cur.get("uuid") not in seen:
        seen.add(cur["uuid"])
        chain.append(cur)
        cur = by.get(cur.get("parentUuid"))
    chain.reverse()
    return chain


def cc_events(recs, target=None):
    by = {r.get("uuid"): r for r in recs if r.get("uuid")}
    parents = {r.get("parentUuid") for r in recs if r.get("parentUuid")}
    # A transcript can hold several leaves (rewinds, edits). Take the longest
    # chain that passes through the checkpoint; fall back to the last record.
    leaves = [r for r in recs if r.get("uuid") and r["uuid"] not in parents and not r.get("isSidechain")]
    best = None
    for leaf in reversed(leaves):
        ch = cc_chain(by, leaf)
        if target is None or any(r.get("uuid") == target for r in ch):
            if best is None or len(ch) > len(best):
                best = ch
    chain = best if best is not None else cc_chain(by, recs[-1])
    results = {}
    for r in recs:
        if r.get("type") != "user":
            continue
        for b in cc_blocks(r):
            if b.get("type") != "tool_result":
                continue
            c = b.get("content")
            txt = c if isinstance(c, str) else "\n".join(str(p.get("text", "")) for p in (c or []) if isinstance(p, dict) and p.get("type") == "text") if isinstance(c, list) else ""
            results[str(b.get("tool_use_id"))] = txt
    ev = []
    for r in chain:
        t = r.get("type")
        if t == "compact-boundary" or (r.get("subtype") == "compact_boundary"):
            ev.append({"kind": "compaction", "id": r.get("uuid")})
            continue
        if r.get("isSidechain"):
            continue
        if t == "user":
            bs = cc_blocks(r)
            if bs and all(b.get("type") == "tool_result" for b in bs):
                ev.append({"kind": "toolResult", "id": r.get("uuid"), "error": any(b.get("is_error") for b in bs)})
                continue
            if r.get("isMeta"):
                continue
            txt = "\n".join(str(b.get("text", "")) for b in bs if b.get("type") == "text")
            if txt.startswith("This session is being continued from"):
                ev.append({"kind": "compaction", "id": r.get("uuid")})
                continue
            if not txt.strip():
                continue
            ev.append({"kind": "user", "id": r.get("uuid"), "text": txt, "harness": is_harness(txt, CC_HARNESS) and not is_relay(txt), "relay": is_relay(txt)})
        elif t == "assistant":
            bs = cc_blocks(r)
            tools = []
            for b in bs:
                if b.get("type") == "tool_use":
                    inp = b.get("input") or {}
                    key = inp.get("file_path") or inp.get("command") or inp.get("pattern") or inp.get("path") or inp.get("url") or inp.get("prompt") or ""
                    tools.append((b.get("name", "?"), str(key)[:90].replace("\n", " "), results.get(str(b.get("id")), "")))
            ev.append(
                {
                    "kind": "assistant",
                    "id": r.get("uuid"),
                    "text": "\n".join(str(b.get("text", "")) for b in bs if b.get("type") == "text"),
                    "tools": tools,
                    "stop": (r.get("message") or {}).get("stop_reason"),
                }
            )
    return ev


# --------------------------------------------------------------------------


def load_events(path, harness, target=None):
    recs = []
    for line in open(path, errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            recs.append(json.loads(line))
        except Exception:
            continue
    if harness == "claude-code":
        return cc_events(recs, target)
    return pi_events(pi_main_branch(recs))


def render_row(row, label, ev, max_user_turns):
    idx = next((i for i, e in enumerate(ev) if e.get("id") == row["entryId"]), None)
    lines = [f"# {row['id']}  ({row.get('session')} / {row.get('stratum')} / {row.get('harness', 'pi')})", ""]
    lines.append(
        f"existing: phase_gold={label.get('phase_gold')} safe={label.get('safe_to_compact')} pivot={label.get('pivot')} "
        f"boundary={label.get('task_boundary')} continuation={label.get('continuation_gold')}"
    )
    lines.append(f"existing note: {squash(label.get('note', ''), 500)}")
    lines.append("")
    if idx is None:
        lines.append("!! checkpoint entry not found on main thread")
        return "\n".join(lines), {"id": row["id"], "found": False}

    # the ask this checkpoint answered
    prev_user = next((e for e in reversed(ev[:idx]) if e["kind"] == "user" and not e.get("harness")), None)
    lines.append("## ASK the checkpoint answered (last real user turn before it)")
    lines.append(f"- {squash(prev_user['text'], 700) if prev_user else '(none found)'}")
    lines.append("")
    lines.append("## CLAIM at the checkpoint (assistant, settled)")
    lines.append(f"- {squash(ev[idx]['text'], 2000)}")
    lines.append("")
    st = row.get("state") or {}
    lines.append("## JUDGE VIEW - user constraints the snapshot kept (last 6)")
    for u in (st.get("userConstraints") or [])[-6:]:
        lines.append(f"- {squash(u.get('text', ''), 260)}")
    lines.append("")
    lines.append("## JUDGE VIEW - recent tail (last 20 of the snapshot's `recent`)")
    for m in (st.get("recent") or [])[-20:]:
        if m.get("role") == "toolResult":
            lines.append(f"- [toolResult:{m.get('tool')}{' ERROR' if m.get('error') else ''}] {squash(m.get('text', ''), 120)}")
        else:
            tools = m.get("tools") or []
            tl = f" {{tools: {', '.join(t.get('tool', '?') for t in tools)}}}" if tools else ""
            lines.append(f"- [{m.get('role')}]{tl} {squash(m.get('text', ''), 320)}")
    lines.append("")
    lines.append("## AFTER the checkpoint")
    sig = {
        "id": row["id"],
        "found": True,
        "harness_turns_before_first_real": 0,
        "compaction_before_first_real": False,
        "next_user": [],
    }
    j = idx + 1
    user_turns = 0
    harness_count = 0
    compaction_seen = False
    while j < len(ev) and user_turns < max_user_turns:
        e = ev[j]
        if e["kind"] == "compaction":
            lines.append(f"- [COMPACTION] at +{j - idx}")
            compaction_seen = True
            j += 1
            continue
        if e["kind"] == "harness":
            lines.append(f"- [{e.get('tag')}] {e['text']}")
            j += 1
            continue
        if e["kind"] == "user":
            if e.get("harness"):
                harness_count += 1
                lines.append(f"- [harness user +{j - idx}] {squash(e['text'], 200)}")
                j += 1
                continue
            user_turns += 1
            if user_turns == 1:
                sig["harness_turns_before_first_real"] = harness_count
                sig["compaction_before_first_real"] = compaction_seen
            lines.append("")
            relay = " RELAY RING (instruction arrives via tool result below)" if e.get("relay") else ""
            lines.append(f"### USER turn {user_turns} (+{j - idx} entries{', after COMPACTION' if compaction_seen else ''}){relay}")
            lines.append(f"> {squash(e['text'], 200 if e.get('relay') else 1200)}")
            # collect the reply: assistant events until the next non-harness user turn
            k = j + 1
            tools = []
            settled_texts = []
            interim_texts = []
            tool_errors = 0
            while k < len(ev):
                f = ev[k]
                if f["kind"] == "user" and not f.get("harness"):
                    break
                if f["kind"] == "compaction":
                    lines.append(f"- [COMPACTION] at +{k - idx}")
                    compaction_seen = True
                elif f["kind"] == "assistant":
                    tools.extend(f["tools"])
                    if f.get("stop") in ("stop", "end_turn") and f["text"].strip():
                        settled_texts.append(f["text"])
                    elif f["text"].strip():
                        interim_texts.append(f["text"])
                elif f["kind"] == "toolResult" and f.get("error"):
                    tool_errors += 1
                elif f["kind"] == "user" and f.get("harness"):
                    lines.append(f"- [harness user +{k - idx}] {squash(f['text'], 160)}")
                k += 1
            names = collections.Counter(t[0] for t in tools)
            lines.append(
                f"REPLY: {len(tools)} tool calls ({', '.join(f'{n}x{c}' for n, c in names.most_common())})"
                + (f", {tool_errors} tool errors" if tool_errors else "")
            )
            for n, key, res in tools[:12]:
                lines.append(f"   - {n}: {key}")
            shown = 0
            for n, key, res in tools:
                if INBOX_KEY.search(key) and res.strip() and shown < 3:
                    lines.append(f"   [inbox/msg via {n}] {squash(res, 900)}")
                    shown += 1
            if len(tools) > 12:
                lines.append(f"   - … {len(tools) - 12} more")
            if interim_texts:
                lines.append(f"   interim: {squash(' | '.join(interim_texts), 500)}")
            if settled_texts:
                lines.append(f"   SETTLED[1/{len(settled_texts)}]: {squash(settled_texts[0], 1400)}")
                if len(settled_texts) > 1:
                    lines.append(f"   SETTLED[last]: {squash(settled_texts[-1], 700)}")
            else:
                lines.append("   SETTLED: (no settled reply before next user turn)")
            txt = e["text"]
            sig["next_user"].append(
                {
                    "turn": user_turns,
                    "offset": j - idx,
                    "chars": len(txt),
                    "backref": bool(BACKREF.search(txt)),
                    "why": bool(WHY.search(txt)),
                    "verdict": bool(VERDICT.search(txt)) or bool(OPTION_TOKEN.search(txt[:80])),
                    "revise": bool(REVISE.search(txt)),
                    "continue": bool(CONTINUE.search(txt)),
                    "reply_tools": len(tools),
                    "reply_from_memory": len(tools) == 0 and bool(settled_texts),
                    "compaction_before": compaction_seen,
                    "relay": bool(e.get("relay")),
                }
            )
            j = k
            continue
        j += 1
    if user_turns == 0:
        lines.append("- (no real user turn follows within the transcript)")
    lines.append("")
    lines.append("## AUDIT")
    lines.append("followup_kind: ")
    lines.append("context_need: ")
    lines.append("safe_to_compact: ")
    lines.append("audit_note: ")
    lines.append("")
    return "\n".join(lines), sig


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    cps, labels, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    max_user_turns = int(sys.argv[4]) if len(sys.argv) > 4 else 4
    os.makedirs(out_dir, exist_ok=True)
    L = {}
    for line in open(labels):
        if line.strip():
            r = json.loads(line)
            L[r["id"]] = r
    rows = [json.loads(l) for l in open(cps) if l.strip()]
    cache = {}
    summary = []
    for row in rows:
        key = (row["sessionFile"], row.get("harness", "pi"))
        if key not in cache:
            cache[key] = load_events(*key)
        ev = cache[key]
        if not any(e.get("id") == row["entryId"] for e in ev):
            ev = load_events(row["sessionFile"], row.get("harness", "pi"), row["entryId"])
        md, sig = render_row(row, L.get(row["id"], {}), ev, max_user_turns)
        with open(os.path.join(out_dir, f"{row['id']}.md"), "w") as f:
            f.write(md)
        sig["stratum"] = row.get("stratum")
        sig["harness"] = row.get("harness", "pi")
        summary.append(sig)
    with open(os.path.join(out_dir, "summary.jsonl"), "w") as f:
        for s in summary:
            f.write(json.dumps(s) + "\n")
    found = sum(1 for s in summary if s["found"])
    print(f"rendered {len(summary)} rows ({found} found on main thread) -> {out_dir}")


if __name__ == "__main__":
    main()
