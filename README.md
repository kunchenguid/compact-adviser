<h1 align="center">compact-adviser</h1>

<p align="center">
  <a href="LICENSE"
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

<h3 align="center">Find a good checkpoint before compacting an AI coding session.</h3>

Compaction is lossy. Size is a bad reason to do it.
**compact-adviser** asks [TypeSafe Jev](https://typesafe.ai) whether the assistant's latest unit of work is actually finished, then tells you to run `/compact` - or, if you opt in, runs it for you.

- **Hints by default** - a pinned line and the shared call to action: **Run /compact to save tokens.** Pi leads with "Good checkpoint: completed work appears recorded."; Claude Code leads with "Potential session boundary detected."
- **One judgment, not two** - a single phase question (completed / still in progress / unclear) with a 0.90 floor. Automatic mode is not a higher bar; it is the same gate, plus a first-use confirmation.
- **Install is consent** - eligible checkpoint context is sent to TypeSafe when a key is available. There is no separate sharing toggle. Uninstall or set mode Off to stop.
- **Two independent hosts** - a Pi extension and a Claude Code mod. Neither loads the other. There is no root runtime.

## Quick Start

Prerequisites: Node 22+, [Pi](https://pi.dev) 0.82.0 or newer (verified on **0.85.1**) or Claude Code 2.1.274 or newer (verified on **2.1.275**), and a [TypeSafe API key](https://console.typesafe.ai/settings/keys) (`TYPESAFE_API_KEY` in the launch environment, or in `./.env`). Jev is TypeSafe's structured decision model; this package asks it one classification question and never asks it to write a summary.

Installing the package is consent to send eligible checkpoint context to TypeSafe when a key is available and the other product gates pass.

### Pi

From this repository:

```sh
npm install
pi install .
```

Restart Pi or run `/reload`, then `/compact-adviser`.
`/compact-adviser status` should say `Key: present`.

From git, without cloning first: `pi install git:github.com/kunchenguid/compact-adviser`.
Once the package is on npm: `pi install npm:compact-adviser` (add `-l` for project-local).

### Claude Code

From this repository:

```sh
claude plugin marketplace add .
claude plugin install compact-adviser@compact-adviser
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

Then `/compact-adviser`. The GitHub form is `claude plugin marketplace add kunchenguid/compact-adviser`.
The mod is a complete no-op unless `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is exactly `1`.

See the [Pi guide](packages/pi-extension/README.md) and the [Claude Code guide](packages/claude-mod/README.md) for settings, commands, privacy, and tests.
[Shared product semantics](docs/product-contract.md) are documentation, not a shared runtime.

## If it does nothing

| Symptom | Cause |
| --- | --- |
| `Key: missing` in `/compact-adviser status` | No `TYPESAFE_API_KEY` in the launch environment or `./.env` |
| No `/compact-adviser` command in Claude Code | `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is not exactly `1` |
| Command exists, no hint | Context is below the constant 40,000-token minimum, the session is not idle, or the last turn was not a settled final answer |
| Claude Code: "nonessential traffic" | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` blocks plugin network requests |
| Pi print / RPC / JSON, or Claude `-p` | Non-interactive sessions never judge |

Uninstall: `pi remove .` (or `pi remove git:github.com/kunchenguid/compact-adviser` / `pi remove npm:compact-adviser`), and `claude plugin uninstall compact-adviser@compact-adviser`.

## What is sent to TypeSafe

| Included | Not sent |
| --- | --- |
| Bounded user constraints, up to the last 64 visible replies and tool results (clipped), short tool-result excerpts, an existing summary, saved-artifact names, omission markers | System prompts, hidden reasoning, images, environment variables, the API key, complete transcripts |
| Best-effort redaction of known key patterns and obvious sensitive-file results | A guarantee. Uninstall or set mode Off for material that must not leave the machine |

Requests go to `https://api.typesafe.ai/v1/systemone`, are capped at 32,000 serialized UTF-8 bytes, and never treat an error as an affirmative judgment.
Details: [SECURITY.md](SECURITY.md).

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
│ TypeSafe Jev      │  one phase factor, shared 0.90 floor
└─────────┬─────────┘
          ▼
 hint: run /compact     or, with explicit auto, native compaction
```

Automatic compaction is experimental and lossy. A high model probability is not proof that a summary will preserve every useful fact.

## Usage

| Command | Effect |
| --- | --- |
| `/compact-adviser` | Settings (mode, minimum, request log) |
| `/compact-adviser auto` / `hint` / `off` | Save that mode; auto asks for first-use confirmation |
| `/compact-adviser status` | Mode, minimum, context, key readiness, cooldown |
| `/compact-adviser threshold 60000` | Save an absolute token minimum |
| `/compact-adviser snooze` / `dismiss` | Suppress the next three exchanges, or clear the current hint |

## Package layout

```
packages/pi-extension/     Pi extension (pi install . from this root, or npm:compact-adviser)
packages/claude-mod/       Claude Code mod (marketplace source)
.claude-plugin/            Same-repo marketplace manifest
docs/product-contract.md   Shared semantics, not a runtime
```

## Development

One-session trials without installing:

```sh
pi -e "$PWD/packages/pi-extension"
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir "$PWD/packages/claude-mod"
```

Checks (resolve the real `pi` / `claude` binaries before npm prepends local PATH):

```sh
npm --prefix packages/pi-extension ci --ignore-scripts
npm run check
COMPACT_TEST_PI_BIN="$(command -v pi)" npm run test:e2e

npm --prefix packages/claude-mod ci --ignore-scripts
npm run check:claude-mod
npm run test:e2e:claude-mod
```

The Pi E2E suite needs Pi 0.82.0 or newer and Python 3.
The Claude live regression needs Claude Code, `tmux`, and uses a local model stand-in plus a loopback TypeSafe fixture.
Neither suite spends provider quota or reads account credentials.

The judgment-eval harness lives in [packages/pi-extension/eval/](packages/pi-extension/eval/README.md).
It is not a published dataset: point it at your own Pi sessions and keep transcripts local.

macOS and Linux are the verified platforms. Windows is untested.
No hosted service or repository publication is required to run from this checkout.
