# compact-adviser for Claude Code

A standalone Claude Code mod that suggests a useful checkpoint for `/compact`, rather than compacting merely because the context is large.

> Compact adviser: work appears completed or recorded. **Run /compact to save tokens.**

Hints are the default.
Automatic mode is an explicit, persistent, experimental opt-in.
No other host's runtime, service, or configuration is required; this package never loads or reads the sibling Pi extension.

## Requirements and status

- Claude Code **2.1.275**, the verified target (2.1.274 or newer).
The mods (function-hooks) plugin API is **early access**: Claude Code says it "may change between releases without notice", and it is not in the public documentation.
Re-run `npm run check` and the live regression after every Claude Code update.
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in Claude Code's launch environment.
Without exactly `1` the module does nothing at all, even if Claude Code's own rollout loads it.
- An interactive session. `-p` and SDK runs never judge, hint, or compact.
- `TYPESAFE_API_KEY` in Claude Code's launch environment, a key entered in `/compact-adviser`, or `TYPESAFE_API_KEY=...` in a `.env` file in the session working directory.
Installing this package is consent to send eligible checkpoint context to TypeSafe when a key is available and other product gates pass.
- Nonessential network traffic allowed: under `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` Claude Code refuses every plugin network request, so no judgment can run; the mod says so and leaves context alone.

No build step or runtime dependency is needed: Claude Code runs the TypeScript hooks module itself.

## Install this package only

Point Claude Code at this directory, not the monorepo root or the Pi package.

From the monorepo root, install through the same-repo marketplace (the verified every-session path):

```sh
claude plugin marketplace add "$PWD"
claude plugin install compact-adviser@compact-adviser
```

and set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` wherever you launch Claude Code.
The GitHub form is `claude plugin marketplace add kunchenguid/compact-adviser`.

For one session without installing:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir "$PWD/packages/claude-mod"
```

The live regression exercises the `--plugin-dir` path; marketplace install was verified separately against Claude Code 2.1.275.

## First-run setup

1. Supply a [TypeSafe API key](https://console.typesafe.ai/settings/keys) in one of these ways, first match wins:
   - A non-empty `TYPESAFE_API_KEY` in Claude Code's launch environment through your normal secret manager.
   - A key entered in `/compact-adviser` (stored with this plugin's other options, hidden from `/config` so the value is never shown).
   - `TYPESAFE_API_KEY=...` in a `.env` file in the working directory.
`export` and `declare -x` prefixes are accepted, and one matching pair of quotes around the value is stripped.
A missing `.env` file is ignored.
Do not commit a key to a repository.
2. Run `/compact-adviser` to choose the mode and minimum context, or leave the defaults (hints, 40,000 tokens).

Installing this package is consent to send eligible checkpoint context to TypeSafe when a key is available and other product gates pass.
Without a key, or with mode Off, no TypeSafe request is made.
The key is never written to logs, status lines, or messages.

## Persistent settings

`/compact-adviser` opens a settings pane: one list of rows, as the Pi extension's menu, each showing the value in effect:

```text
Compact adviser  saved for all sessions

Mode                    Hints only (default)
Minimum context         40,000 tokens
Log TypeSafe requests   Off
TypeSafe API key        from .env
Reset minimum to 40,000
Status
Close
↑↓ move · Enter select · Esc close
```

The arrow keys (or Tab) move between rows and Enter opens the highlighted row's own view; Escape closes the pane.
In a view, Enter picks the highlighted option or saves the field, and Escape or Back returns to the list without saving an unsubmitted edit.

**Mode** offers Hints only, Automatic (experimental), and Off, the current one marked.
The first Automatic selection requires confirmation about lossy compaction and its across-project scope.
Selecting Automatic does not compact immediately.

**Minimum context** opens a field prefilled with the saved number, initially `40000`.
Edit it and press Enter to validate and save.
Blank, zero, negative, fractional, exponential, suffixed (`40k`), nonnumeric, and unsafe-integer inputs are rejected with a message beneath the field, and the typed text stays for correction.
A value at or above the current model's window is saved with a warning; it is never clamped.
Reset changes only the minimum, not the mode, request logging, the saved TypeSafe key, or session cooldowns.

**TypeSafe API key** shows which key is in effect and where it comes from, never the value: `from the environment` (a non-empty launch-environment `TYPESAFE_API_KEY`), `saved` (a key entered here), `from .env` (a `TYPESAFE_API_KEY` assignment in the working directory's `.env`), or `missing`.
Its view spells the same out, including a saved key that the launch environment overrides.
Paste a key into the field and press Enter to save it; Clear saved key removes only the key saved here, so a launch-environment or `.env` key still applies and the list says so.

`mode`, `minContextTokens`, `logRequests`, and `typesafeApiKey` are this plugin's declared `userConfig` options.
Claude Code validates them and stores them in your user `settings.json` under `pluginConfigs["compact-adviser@…"].options`.
`mode`, `minContextTokens`, and `logRequests` also appear in `/config`; `typesafeApiKey` is hidden there so the secret is never drawn.
The automatic-mode acknowledgement lives in the plugin's own store, so only this mod's confirmation dialog can grant experimental auto.
A legacy `sharingConsent` field in that store is ignored.
Mode, minimum, request logging, a saved TypeSafe key, and the acknowledgement survive restarts, `--resume`, compaction, and project changes.
`/compact-adviser status` reports the key source as `env`, `saved`, `.env`, or `missing`, never the value.
A value a managed setting owns, or any refused save, is reported as not saved.

Claude Code reloads a mod whenever one of its options is saved, and prints a dim "options changed, reloaded" line for it in the transcript; that line is Claude Code's own notice, not a model message.

### Direct commands

| Command | Effect |
| --- | --- |
| `/compact-adviser` | Settings pane |
| `/compact-adviser auto` | Save automatic mode, with first-use confirmation |
| `/compact-adviser hint` | Save hints-only mode |
| `/compact-adviser off` | Save Off: no hints or TypeSafe requests |
| `/compact-adviser status` | Mode, minimum, context usage, key source (`env` / `saved` / `.env` / `missing`), cooldown, Claude Code's own auto-compact threshold |
| `/compact-adviser threshold 60000` | Save an absolute 60,000-token minimum |
| `/compact-adviser threshold default` | Restore the constant 40,000-token minimum |
| `/compact-adviser snooze` | Suppress advice for the next three completed exchanges |
| `/compact-adviser dismiss` | Clear the current hint |

Confirmations appear as short notices under the prompt; `status` writes one dim transcript line, which is not sent to the model.
Turning the mod off does **not** disable Claude Code's own auto-compaction (`/autocompact`); the mod never blocks or rewrites any compaction.
There is no standing status strip for mode or readiness; a hint or an in-progress automatic compaction may pin a line until the next turn.

## When it judges

The mod observes `turn.complete`, once per main-loop turn after the final answer.
Subagent turns, interrupted, refused, or errored turns, and empty answers are not checkpoints.
The hook itself never waits on the network: it counts the exchange, runs the cheap checks below, and schedules the judgment.

Before any request it requires:

- Known context usage (`$.session.usage()`) of at least the configured minimum tokens.
There is **no percentage threshold**.
Usage is unknown immediately after a compaction until the next response; the mod waits rather than reusing an older count.
- Mode not Off, a key, and no judgment or compaction already in flight.
- More than approximately 20k tokens of actual conversation text, so a large static prompt alone does not justify compaction.
- No error backoff or snooze.
- After any compaction (yours, Claude Code's automatic one, or this mod's): fresh usage, at least 20k growth from the first post-compaction usage, and three completed exchanges.
- A different latest-ask/latest-reply checkpoint fingerprint than the last hint.

Cooldown facts live in the plugin's store keyed by session id and are pruned after 30 days.
A new turn, any compaction, or a settings save invalidates an outstanding judgment.

## The judgment and its limits

One HTTPS request to `https://api.typesafe.ai/v1/systemone`, through Claude Code's host fetch, uses `jev-latest` and the Pi extension's two typed factors, each a one-sentence question:

1. `done`: is the assistant's own latest unit of work finished, not finished, or unclear. Waiting for a person or another party counts as finished.
2. `shape`: did the assistant mostly do the work itself (hands-on) or mostly coordinate others.

Local code composes them into one score, P(finished) x (0.5 + 0.5 x P(hands_on)); Jev does not generate an explanation.
Malformed responses, contradictory factors, API failures, and timeouts never produce a hint or a compaction.
Requests have a two-second deadline, no immediate retry, and capped exponential backoff.

Hint and auto share one floor on that score, and the floor depends on how full the context window is (`$.session.usage()` tokens over the model's window): 0.90 while usage is at most 10 %, then a linear ramp down to 0.50 from 90 % on (`/compact-adviser status` shows the current floor).
A wrong hint costs most while there is room left and least when compaction is imminent anyway.
These are measured starting knobs, **not safety guarantees**; the Pi package's `eval/README.md` has the ladder.

A hint pins the yellow line `Compact adviser: work appears completed or recorded. Run /compact to save tokens.` under the prompt until your next turn.
The pinned status is the only hint surface; there is no matching toast or prompt suggestion.

Automatic mode still requires the first-use acknowledgement to turn auto on.
Once enabled, it fires on the same qualifying judgment a hint would.
Immediately before acting, the mod rereads saved settings, re-checks eligibility, and confirms no newer turn started.
It then calls Claude Code's own compaction (`$.session.compact`) once, with instructions to keep the current work, pending tasks, referenced files, and next step exact.
A vetoed or failed compaction backs off for a minute and is reported.
A completed one is recorded as a dim transcript line such as `compact-adviser: automatic compaction completed: 70,040 to 1,113 tokens.`

Compaction replaces older messages with a lossy summary.
Exact tool output and long file contents are what the summary compresses away, and the user's next request cannot be observed in advance.
Use hint mode if another plugin customizes compaction in ways this mod cannot observe.

## Privacy and costs

The request includes bounded user requests, up to the last 64 recent visible replies and tool results clipped by existing byte budgets, short tool-result excerpts (long dumps keep a head and tail), a prior compaction summary when present, names of files written by edit tools, and explicit omission markers.
System prompts, hidden reasoning, images, environment variables, and complete transcripts are not sent.
The saved-key guarantee is defined in the repository [security policy](../../SECURITY.md). Filtering of other known key patterns and obvious sensitive-file results (`.env`, `*.pem`, `id_rsa`, ...) is **best-effort**, not comprehensive secret detection.
Installing this package is consent to send eligible checkpoint context to TypeSafe; uninstall it or set mode Off if that is not acceptable.

Optional request logging is off by default. Enable **Log TypeSafe requests** from `/compact-adviser` (or `/config`) to append each judgment request and its Jev outcome to `~/.claude/compact-adviser-requests-<session-id>.jsonl` (one file per Claude Code session, so concurrent sessions cannot drop lines). Successful outcome records contain answers, score, usage, floor, and qualifies; failures contain only a sanitized error kind. The log never includes the TypeSafe API key used for the request. Redaction of other known key patterns and sensitive-file results remains best-effort, as described above.

Requests are capped at 32,000 serialized UTF-8 bytes, about an 8k-token budget; oversized requests are refused locally.
Published Jev pricing during development was $0.042 per million input tokens with free output, so an 8k-token request is about $0.0003.
Pricing and limits can change.

## Differences from the Pi extension

| Pi extension | Claude Code mod | Why |
| --- | --- | --- |
| `compact-adviser.json` in Pi's agent directory holds mode, minimum, request logging, a saved TypeSafe key, and the auto acknowledgement | `mode`, `minContextTokens`, and `logRequests` are host-stored `userConfig` options (also in `/config`); `typesafeApiKey` is the same settings path but hidden from `/config`; the auto acknowledgement is in the plugin store | Claude Code gives plugins a declared, validated configuration surface; `/config` must not display the API key, and a `/config` toggle must not bypass the auto confirmation |
| Menu from Pi's select and input dialogs | One settings pane: the same list of rows, each opening its own options or field in the pane; confirmations in Claude Code's own question dialog | Same rows and flow on Claude Code's elements, which draw a pane rather than a dialog |
| Judges at `agent_settled` | Judges at `turn.complete` for the main loop | Claude Code's turn end is already the settled point |
| Yellow sticky widget above the editor | Yellow status line until the next turn | One hint surface per host |
| Cooldowns in Pi session entries | Cooldowns in the plugin store by session id | Plugins cannot write session entries |
| Compaction retains Pi's ~20k recent tokens; auto cancels if configured lower | Claude Code's summary plus a few recent messages; the judge is told so | Claude Code exposes no retained-tail setting to check |
| Stable public extension API | Early-access mods API behind `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` | Platform status |

Both hosts use the shared hint `Compact adviser: work appears completed or recorded. Run /compact to save tokens.`

## Verification

From this directory:

```sh
npm ci --ignore-scripts
npm run check
npm run test:e2e
```

`check` regenerates the plugin API declarations from the installed Claude Code (`/plugin-types`, in a throwaway configuration), type-checks, runs Biome, runs `claude plugin validate --strict` and asserts the hooks and environment reads it reports, then runs the behavioral suites under `claude plugin test` (the lib suite covers settings, cooldowns, the bounded judge input, and the Jev client; the adviser suite drives the hooks module through the engine's own host with mocked usage, transcript, store, clock, and TypeSafe).

`test:e2e` requires `tmux` and drives the **real Claude Code TUI** with an isolated configuration directory, `--plugin-dir`, a local deterministic stand-in for the Anthropic Messages API, and a local TypeSafe fixture reached through the loopback-only `COMPACT_ADVISER_TEST_ENDPOINT` override (any non-`127.0.0.1` value is ignored).
It checks the inert flag-off path, the settings pane driven by the arrows and Enter alone (a row's view, refused `40k`, saved `60000` in the host's options, Escape back to the list and then closing), a judged hint and its clearing without ambient chrome, and automatic mode chosen in the pane compacting exactly once through Claude Code's own compaction.
Set `COMPACT_TEST_CLAUDE_BIN` to test a different Claude Code binary.
It spends no model quota and reads no account credential.

These tests establish integration and safety behavior, **not Jev's classification accuracy** or continuation quality after a real summary.
Live Jev behavior was not re-measured for this package; a consented evaluation with real transcripts remains necessary before automatic timing can be called reliable.
