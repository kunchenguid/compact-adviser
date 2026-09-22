<h1 align="center">compact-adviser</h1>

<p align="center">
  <a href="https://github.com/kunchenguid/compact-adviser/blob/main/LICENSE"
    ><img
      alt="License"
      src="https://img.shields.io/badge/license-MIT-green?style=flat-square"
  /></a>
  <a
    href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"
    ><img
      alt="Platform"
      src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"
  /></a>
  <a href="https://x.com/kunchenguid"
    ><img
      alt="X"
      src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square"
  /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"
    ><img
      alt="Discord"
      src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord"
  /></a>
</p>

**compact-adviser** is an agent plugin that answers a single question: should I /compact now?

![Compact adviser status line: "Compact adviser: work appears completed or recorded. Run /compact to save tokens." shown above a terminal prompt](https://raw.githubusercontent.com/kunchenguid/compact-adviser/main/docs/hint-status-line.png)

It uses [Jev](https://typesafe.ai) to instantly judge whether the current session is likely at a boundary that's safe to compact.

It can give you a hint to run `/compact` - or, on Pi and Claude Code, if you opt in, it can run it for you at the right time automatically. Codex CLI and Grok are hint-only: nothing outside their sessions can trigger `/compact`.

Judgment is two one-sentence Jev questions in one request (is the unit finished; is this hands-on work or coordination), composed in code into one score. The hint floor is 0.90 while the context is mostly empty (through about 10%) and relaxes toward 0.50 by about 90% full - a wrong hint costs most when there is still room. "Full" means the point where the host compacts: on Claude Code that is its auto-compact threshold when enabled, elsewhere the model's window. Automatic mode is the same gate, plus a first-use confirmation.

## Quick Start

Prerequisites: Node 22+ (22.18+ for Codex and Grok), and one of [Pi](https://pi.dev) 0.82.0 or newer (verified on **0.85.1**), Claude Code 2.1.274 or newer (verified on **2.1.275**), Codex CLI 0.153.0 or newer (verified on **0.153.4**), or [Grok Build](https://docs.x.ai/build/overview) 1.0.34 or newer (verified on **1.0.34**), plus a [TypeSafe API key](https://console.typesafe.ai/settings/keys). Supply it as `TYPESAFE_API_KEY` in the launch environment or put it in the session cwd's `./.env`; Pi and Claude Code can also save it through their settings, while Codex and Grok provide an external compact-adviser CLI. Jev is TypeSafe's structured decision model; this package asks it two one-sentence classification questions and never asks it to write a summary.

Installing the package is consent to send eligible checkpoint context to TypeSafe when a key is available and the other product gates pass.

### Pi

```sh
pi install npm:compact-adviser
```

Restart Pi or run `/reload`, then `/compact-adviser`.
`/compact-adviser status` should say `Key: env`, `Key: saved`, or `Key: .env`.

To install from git: `pi install git:github.com/kunchenguid/compact-adviser` (add `-l` for project-local).

### Claude Code

This plugin uses Claude Mod which is an experimental feature that requires `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in your environment.

```sh
claude plugin marketplace add kunchenguid/compact-adviser
claude plugin install compact-adviser@compact-adviser
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

Then `/compact-adviser`.

### Codex CLI

Codex support is **macOS and Linux only**. The plugin's hooks run through POSIX `sh`, matching
this repository's platform badge; Windows is not supported this ship.

```sh
codex plugin marketplace add kunchenguid/compact-adviser
codex plugin add compact-adviser@compact-adviser
```

Restart Codex and review the hook in `/hooks` once, so it is trusted. After a completed
checkpoint the advice appears as a `↳ Hook · Compact adviser: ...` line under the answer.

Codex is **hint-only**: it has no surface that lets another process run `/compact`, so there is
no automatic mode there. Settings live in a small CLI instead of a slash command; ask Codex for
"compact-adviser status" and the bundled skill runs it, or run it yourself:

```sh
node "$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/*/compact-adviser/*/ | tail -1)src/cli.ts" status
```

### Grok Build

Grok is **hint-only**: nothing outside a running session can trigger `/compact`, so there is no automatic mode here. The hint is painted on the status row and never enters the model's context.

```sh
grok plugin install kunchenguid/compact-adviser#packages/grok-plugin --trust
```

(Install from the subdirectory, not the repository root: Grok also reads the Claude marketplace index in this repo, so a plain `grok plugin marketplace add` offers two plugins of the same name and refuses an unqualified install.)

Then two one-time steps, because Grok does not let a plugin do either of them for you. Start Grok and run:

```
/compact-adviser-install
```

That writes `${GROK_HOME:-~/.grok}/hooks/compact-adviser.json`, because **Grok 1.0.34 lists a plugin's own `hooks/hooks.json` but never loads it into a session**. Hooks in your own Grok home are always trusted, so nothing else is needed; delete that file to remove them. From a shell it is `node "$(node -e 'const l=JSON.parse(require("child_process").execFileSync("grok",["plugin","list","--json"],{encoding:"utf8"})); const p=(Array.isArray(l)?l:[]).find(x=>x&&x.name==="compact-adviser"); if(!p||typeof p.path!=="string") throw new Error("compact-adviser is not installed"); process.stdout.write(p.path)')/bin/adviser.ts" install`. After `install`, `${GROK_HOME:-~/.grok}/compact-adviser/adviser.sh` resolves the currently installed plugin the same way.

Then paste the `[ui.status_line]` block `install` printed into the config.toml path it named and restart Grok. The status row is off by default and only your own config can turn it on - a plugin cannot, and neither can a repository. Grok has one status row, so this script paints the built-in segments (`cwd`, `model`, `context`) too. Minimal render mode has no status row at all.

On Grok, save the TypeSafe key as `TYPESAFE_API_KEY` or a cwd `.env`, or with the CLI `key` command from a shell outside Grok. Do not type secrets after a Grok slash command; Grok appends those words to the model.

## If it does nothing

| Symptom | Cause |
| --- | --- |
| `Key: missing` in `/compact-adviser status` (Pi, Claude Code) or `/compact-adviser` (Grok) | No `TYPESAFE_API_KEY` in the launch environment, saved settings, or the session cwd's `./.env` |
| No `/compact-adviser` command in Claude Code | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is not exactly `1` |
| Command exists, no hint | Context is below the constant 40,000-token minimum, the session is not idle, or the last turn was not a settled final answer |
| Claude Code: "nonessential traffic" | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` blocks plugin network requests |
| No hint in Codex | The hook is untrusted (review it in `/hooks`), Node is older than 22.18, or the hook cannot find Node at all - Codex rebuilds its PATH, so set `COMPACT_ADVISER_NODE` to an absolute `node` path |
| Grok: no hint row at all | `[ui.status_line]` is not set in the `config.toml` `install` named, or Grok is in minimal render mode |
| Grok: no hint after a completed turn | `/compact-adviser-install` has not run, so no Stop hook is judging |
| Pi print / RPC / JSON, Claude `-p`, or `codex exec` | The adviser stays inert in reliably detected non-interactive sessions |
| Nothing at all, in any host | `COMPACT_ADVISER_DISABLE` is set to a truthy value |

## Environment variables

| Variable | Effect |
| --- | --- |
| `TYPESAFE_API_KEY` | The Jev key; a saved key or the session cwd's `./.env` is used when this is unset |
| `COMPACT_ADVISER_DISABLE` | `1`, `true`, `yes` or `on` (any case) makes the session inert: no TypeSafe request, no hint, no automatic compaction, no command. It wins over a saved `hint` or `auto` mode |
| `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` | Claude Code only; must be exactly `1` for the mod to load |
| `COMPACT_ADVISER_NODE` | Codex only; absolute path to a Node 22.18 or newer executable when the hook cannot find one on its rebuilt PATH |

Export `COMPACT_ADVISER_DISABLE=1` for unattended agent sessions, where advice has nobody to read it.

## What is sent to TypeSafe

| Included | Not sent |
| --- | --- |
| Bounded user constraints, up to the last 64 visible replies and tool results (clipped), short tool-result excerpts, an existing summary, saved-artifact names, omission markers | System prompts, hidden reasoning, images, environment variables, the API key in the model context and request body, complete transcripts |
| Best-effort redaction of known key patterns and obvious sensitive-file results | A guarantee. Uninstall or set mode Off for material that must not leave the machine |

Requests go to `https://api.typesafe.ai/v1/systemone`, are capped at 32,000 serialized UTF-8 bytes, and never treat an error as an affirmative judgment.
The TypeSafe API key never enters the model context or the request body; it is sent as the Authorization header to authenticate the call.
Details: [SECURITY.md](https://github.com/kunchenguid/compact-adviser/blob/main/SECURITY.md).

## How It Works

```
settled turn
      │
      ▼
┌───────────────────┐
│ cheap local gates │  mode, 40k minimum, idle session, key, cooldowns
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ TypeSafe Jev      │  done × shape score, floor slides 0.90→0.50 with usage
└─────────┬─────────┘
          ▼
 hint: run /compact     or, with explicit auto, native compaction
```

Automatic compaction is available on Pi and Claude Code. On Codex the same judgment only ever
produces the hint, as a `↳ Hook ·` line in the scrollback. On Grok the two halves are separate
processes: a `Stop` hook judges and records a verdict, and the `[ui.status_line]` script reads
that verdict and paints the hint. The Grok hook always allows the stop and prints nothing, so a
hint can never be fed back to the model.

## Usage

| Command | Effect |
| --- | --- |
| `/compact-adviser` (Pi and Claude Code) | Settings (mode, minimum, request log, TypeSafe API key) |
| `/compact-adviser auto` / `hint` / `off` (Pi and Claude Code) | Save that mode; auto asks for first-use confirmation |
| `/compact-adviser status` (Pi and Claude Code) | Mode, minimum, context, key source (`env` / `saved` / `.env` / `missing`), cooldown |
| `/compact-adviser threshold 60000` (Pi and Claude Code) | Save an absolute token minimum |
| `/compact-adviser snooze` / `dismiss` (Pi and Claude Code) | Suppress the next three exchanges, or clear the current hint |
| `/compact-adviser` (Grok) | Show status; do not add arguments because Grok sends them to the model |
| `/compact-adviser-hint` / `/compact-adviser-off` (Grok) | Save hint-only mode, or disable the adviser |
| `/compact-adviser-snooze` / `/compact-adviser-dismiss` (Grok) | Suppress the next three exchanges, or clear the current hint |
| `/compact-adviser-install` (Grok) | Register the hooks and print the status-line block to paste into the named `config.toml` |
| `${GROK_HOME:-$HOME/.grok}/compact-adviser/adviser.sh threshold 60000` (Grok shell) | Save an absolute token minimum; `help` lists the other shell-only settings |

On Codex the same commands are arguments to the plugin's `src/cli.ts` (`status`, `hint`, `off`,
`threshold`, `log on|off`, `key set|clear|status`) rather than a slash
command, because Codex plugins cannot register a command with code behind it. Codex has no
snooze or dismiss: the CLI cannot tell which session is current.

## Judge profiles

An optional [judge profile](https://github.com/kunchenguid/compact-adviser/blob/main/docs/judge-profiles.md) changes the two questions, score weight, or floor schedule without changing shipped defaults. All four hosts accept the same bounded JSON string in the `profile` setting. Keep hint mode while evaluating a profile. Invalid profiles disable advice, and loading a profile never grants automatic-mode consent.

## Eval

Local judgment eval uses real session checkpoints to score when the adviser should suggest `/compact`. The curve below is from a follow-up-aware gold set (96 checkpoints, 40 sessions): as the context window fills, the score threshold loosens from **0.90** (≤10% used) to **0.50** (≥90% used) so **recall rises** while precision stays high - favoring token savings when compaction is about to be forced anyway.

![Use Jev to answer "should I /compact now?" — precision stays high while recall rises as context used goes from ≤10% to ≥90%](https://raw.githubusercontent.com/kunchenguid/compact-adviser/main/docs/eval-usage-floor-curve.png)

The judgment-eval harness lives in [packages/pi-extension/eval/](https://github.com/kunchenguid/compact-adviser/blob/main/packages/pi-extension/eval/README.md). It is not a published dataset: point it at your own sessions and keep transcripts local.
