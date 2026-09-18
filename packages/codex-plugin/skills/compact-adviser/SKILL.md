---
name: compact-adviser
description: Read or change compact-adviser settings for Codex - the mode (hint or off), the minimum context before a checkpoint is judged, TypeSafe request logging, the TypeSafe API key, and per-session snooze. Use when the user asks about compaction advice, the /compact hint, compact-adviser status, or wants to turn the adviser on or off.
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

Node 22.18 or newer is required, because the CLI is TypeScript that Node strips types from.

## Commands

| Command | Effect |
| --- | --- |
| `status` | Mode, minimum, key source, the latest session's cooldown, and the request-log path |
| `hint` | Advise with a hint at eligible checkpoints (the default) |
| `off` | Stop advising; Codex's own compaction is unaffected |
| `threshold <tokens\|default>` | Save an absolute token minimum |
| `log <on\|off>` | Log each TypeSafe request and its outcome to a local jsonl file |
| `key set` | Prompt for a TypeSafe API key and save it; the value is never printed |
| `key clear` / `key status` | Remove the saved key, or report which source the key in effect came from |
| `snooze` | Suppress advice for the next three completed exchanges |
| `dismiss` | Suppress advice until the next completed exchange |

`key set` reads the key from the terminal, so ask the user to run that one themselves rather
than passing a key on a command line. Never print, echo, or repeat a key value.
