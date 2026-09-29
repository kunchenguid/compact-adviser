---
name: compact-adviser
description: Read or change compact-adviser settings for Codex - the mode (hint or off), the minimum context before a checkpoint is judged, TypeSafe request logging, the judge (TypeSafe directly or Vercel's AI Gateway), and the judge's API key. Use when the user asks about compaction advice, the /compact hint, compact-adviser status, or wants to turn the adviser on or off.
---

# compact-adviser settings

compact-adviser watches for a completed checkpoint and prints one hint to run `/compact`.
It cannot run `/compact` itself: Codex exposes no way for an outside process to do that, so
this host is hint-only and there is no automatic mode. Never claim otherwise.

## How to run it

Settings live in a small CLI inside this plugin. From the directory that holds this
`SKILL.md`, the CLI is at `../../src/cli.ts`; run it with the absolute path:

```bash
node "<this skill's directory>/../../src/cli.ts" <command>
```

macOS or Linux and Node 22.18 or newer are required, because the CLI is TypeScript that Node strips types from and the hooks run through POSIX `sh`.

## Commands

| Command | Effect |
| --- | --- |
| `status` | Mode, minimum, judge, key source, the latest session's cooldown, and the request-log path |
| `hint` | Advise with a hint at eligible checkpoints (the default) |
| `off` | Stop advising; Codex's own compaction is unaffected |
| `threshold <tokens\|default>` | Save an absolute token minimum |
| `log <on\|off>` | Log each TypeSafe request and its outcome to a local jsonl file |
| `judge <typesafe\|vercel>` | Ask Jev at TypeSafe (the default) or through Vercel's AI Gateway, which then receives the checkpoint context on its way to Jev |
| `key set` | Prompt for the judge's API key (TypeSafe, or AI Gateway for `vercel`) and save it; the value is never printed |
| `key clear` / `key status` | Remove the saved key, or report which source the key in effect came from |

`key set` reads the key from the terminal, so ask the user to run that one themselves rather
than passing a key on a command line. Never print, echo, or repeat a key value.
Choose `judge vercel` only when the user asks for it: it changes who receives the checkpoint
context, from TypeSafe to Vercel's AI Gateway on its way to Jev.
