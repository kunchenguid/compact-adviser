# compact-adviser for Pi

A standalone Pi extension that suggests a useful checkpoint for `/compact`, rather than compacting merely because the context is large.

> Good checkpoint: completed work appears recorded. **Run /compact to save tokens.**

Hints are the default.
Automatic mode is an explicit, persistent, experimental opt-in.
No other host's runtime, service, or session records are required.

## Install this package only

From the monorepo root (the fool-proof path; this also works as `pi install git:github.com/kunchenguid/compact-adviser`):

```sh
npm install
pi install "$PWD"
```

To install only this package directory:

```sh
npm --prefix packages/pi-extension ci --omit=dev --omit=peer --ignore-scripts
pi install "$PWD/packages/pi-extension"
```

Restart Pi or run `/reload`.
Do not install the reserved Claude-mod directory as a Pi extension.
The monorepo root is the git-install shape; `packages/pi-extension` is the npm package.
Pi supplies its own core and TUI modules; the package's only additional runtime dependency is `proper-lockfile`.
For a one-run trial, use `pi -e /absolute/path/to/packages/pi-extension` instead of `pi install`.

Requires Node 22+ and the Pi 0.82.0 extension API.
Verified with the actual signed Pi **0.85.1** runtime; 0.82.0 remains the API floor.
Only interactive TUI mode acts; RPC, JSON, and print modes do not make advice requests or compact.
The underlying model provider can be any provider supported by Pi.

## First-run setup

1. Supply `TYPESAFE_API_KEY` through Pi's launch environment, or as `TYPESAFE_API_KEY=...` in a `.env` file in the process current working directory.
`export` and `declare -x` prefixes are accepted, and one matching pair of quotes around the value is stripped.
A non-empty launch-environment value always wins; the file is read only when the variable is unset or empty, and a missing file is ignored.
Do not paste a key into the settings dialog or commit one to the repository.
2. Run `/compact-adviser` to choose mode and minimum context, or leave the defaults (hints, 40,000 tokens).

Installing this package is consent to send eligible checkpoint context to TypeSafe when a key is available and other product gates pass.
Without a key, or with mode Off, no TypeSafe request is made.
No credentials are written to the extension's configuration or session entries.

## Persistent settings

`/compact-adviser` opens a native Pi menu:

```text
Mode: hint
Minimum context: 40,000 tokens
Log TypeSafe requests: off
Reset minimum to 40,000
Status
Close
```

**Mode** offers Hints only, Automatic, and Off.
The first Automatic selection requires confirmation about lossy compaction and its across-project scope.
Selecting Automatic does not compact immediately.

**Minimum context** opens a prefilled input containing the saved number, initially `40000`.
Edit it and press Enter to validate and save; Escape preserves the previous value.
The confirmation states the new token count and that it applies to all sessions.
Blank, zero, negative, fractional, exponential, suffixed (`40k`), nonnumeric, and unsafe-integer inputs are rejected.
Use whole decimal tokens such as `60000`.
A value at or above the current model's window is allowed but produces a warning; it is not silently clamped.
Reset changes only the minimum, not the mode, request logging, or session cooldowns.

The configuration lives in `getAgentDir()/compact-adviser.json`, normally `~/.pi/agent/compact-adviser.json`:

```json
{
  "version": 1,
  "mode": "hint",
  "minContextTokens": 40000,
  "autoAcknowledged": false,
  "logRequests": false
}
```

Mode, minimum, request logging, and the automatic-mode acknowledgement survive restart, `/new`, `/resume`, compaction, and project changes.
A legacy `sharingConsent` field is ignored and dropped on the next save.
Project files cannot silently override them.
Atomic writes and a short cross-process lock prevent partial saves and lost concurrent field updates.
A busy lock or failed save is reported instead of claiming success.
Other open sessions reread preferences before acting.
Unreadable, malformed, unsupported-version, oversized, or symlinked settings suppress action and display an error; repair that file rather than expecting a silent reset.

### Direct commands

| Command | Effect |
| --- | --- |
| `/compact-adviser` | Settings menu |
| `/compact-adviser auto` | Save automatic mode, with first-use confirmation |
| `/compact-adviser hint` | Save hints-only mode |
| `/compact-adviser off` | Save Off: no hints or TypeSafe requests |
| `/compact-adviser status` | Mode, minimum, context usage, key readiness, cooldown, settings path |
| `/compact-adviser threshold 60000` | Save an absolute 60,000-token minimum |
| `/compact-adviser threshold default` | Restore the constant 40,000-token minimum |
| `/compact-adviser snooze` | Suppress advice for the next three completed exchanges |
| `/compact-adviser dismiss` | Clear the current hint |

Turning this extension off does **not** disable Pi's built-in near-limit or overflow compaction.
Leaving auto invalidates outstanding judgments; a compaction already running remains under Pi's normal controls.

## When it judges

The extension cheaply observes internal turn ends, but makes a request only at `agent_settled` after a successful final response.
A tool return, unfinished tool loop, error, interruption, or length-limited response is not a positive checkpoint.

Before any request it requires:

- A known active model and context estimate, with at least the configured minimum tokens.
There is **no percentage threshold**.
Cached input counts toward context; cumulative spending does not determine eligibility.
- An idle session, no pending messages or unsent editor text, and no judgment or compaction already in flight.
- More than approximately 20k tokens of actual conversation history, so a large static system prompt alone does not justify compaction.
- A key, and no error backoff or snooze.
- After successful compaction: fresh usage, at least 20k growth from the first post-compaction usage, and three completed exchanges.
- At least three exchanges between hints, and a materially different current-user/final-reply checkpoint fingerprint.

Cooldown facts persist as small Pi custom entries on the active branch and are restored on reload/navigation.
They do not enter model context.
Pi deliberately reports unknown usage immediately after compaction; the extension waits rather than reusing pre-compaction counts.

## The judgment and its limits

One HTTPS request to `https://api.typesafe.ai/v1/systemone` uses `jev-latest` and one typed factor:

1. Completed checkpoint, still in progress, or unclear.

Local code combines the results and renders the reason.
Jev does not generate an explanatory paragraph.
Malformed responses, contradictory factors, API failures, timeouts, and stale results never trigger compaction.
Requests have a two-second deadline, no immediate retry, and capped backoff on later eligible exchanges.
The remote call is not awaited by Pi's event dispatcher.
Input, model/branch/session changes, and native compaction invalidate an outstanding result.

Hint and auto share one 0.90 floor on the completed-checkpoint probability.
These are conservative starting knobs in code, **not measured safety guarantees**.
Do not interpret a concentrated probability distribution as proof that a summary will preserve every useful fact.

Automatic mode still requires the first-use acknowledgement to turn auto on.
Once enabled, it fires on the same qualifying judgment a hint would.
Older omitted messages are explicitly disclosed to the judge; they remain a source of uncertainty.
Immediately before action, the extension rereads saved preferences and checks the same session, branch, model, idle state, pending input, and cooldown.
It then calls Pi's native `ctx.compact()` without substituting a custom summary.
If Pi's actual preparation retains fewer than the assumed 20k recent tokens, automatic compaction is cancelled before summary generation; manual and native automatic compaction are not blocked.
Other extensions can still customize or cancel native compaction.
Use hint mode if another extension changes compaction semantics in ways this adviser cannot observe.

Compaction keeps a lossy summary plus a recent tail, not every exact older detail.
Pi's default summary serialization truncates tool results to 2,000 characters.
Old constraints, long-log tails, hidden dependencies, and unknown future user requests can defeat a timing judgment.
Full transcript recovery is possible, but those details are no longer automatically in the next model context.
The separate summarization request costs tokens and can reduce prompt-cache reuse: the hint is not a promise of net billing savings in every case.

## Privacy and costs

The request includes bounded user constraints, up to the last 64 recent visible replies and tool results clipped by existing byte budgets, short tool-result excerpts (long dumps keep a head and tail), an existing summary when present, saved-artifact names, and explicit omission markers.
System prompts, hidden reasoning, images, raw environment variables, and complete transcripts are not sent by default.
Known key patterns and obvious sensitive-file results are filtered, but this is **best-effort**, not comprehensive secret detection.
Installing this package is consent to send eligible checkpoint context to TypeSafe; uninstall it or set mode Off if that is not acceptable.

Optional request logging is off by default. Enable **Log TypeSafe requests** from `/compact-adviser` to append each judgment body to `getAgentDir()/compact-adviser-requests.jsonl` (normally `~/.pi/agent/compact-adviser-requests.jsonl`). The log is the redacted request body plus questions; it never includes the API key.

Requests are capped at 32,000 serialized UTF-8 bytes, approximately an 8k-token budget for typical English input; Jev's tokenizer can differ.
Oversized requests are refused locally rather than sent.
Published Jev pricing during development was $0.042 per million input tokens, with free output; an 8k-token request is approximately $0.000336.
Pricing, account limits, and actual billed token counts can change.

## Verification

From the monorepo root:

```sh
npm --prefix packages/pi-extension ci --ignore-scripts
npm run check
COMPACT_TEST_PI_BIN="$(command -v pi)" npm run test:e2e
```

`check` performs TypeScript checking, Biome lint/format checking, and behavioral tests.
The separate E2E suite requires Python 3 and the **actual Pi 0.82.0 or newer executable** (verified on 0.85.1), resolved before npm prepends local binaries to PATH.
It drives a real pseudo-terminal, package installation in an isolated agent directory, the native settings UI, settled events, hint rendering, and native compaction.
All model/TypeSafe responses in those integration tests are deterministic local fixtures; they do not spend provider quota or read account credentials.
No shared Pi installation or real user configuration is modified.

The tests establish integration and safety behavior, **not Jev's classification accuracy**.
A real continuation-quality evaluation with consented transcripts and an authenticated Jev account remains necessary before automatic timing can be called reliable.
The judgment-eval harness, label schema, and gold rubric live in [eval/](eval/README.md). Session transcripts, checkpoints, worksheets, and results stay gitignored under `eval/local/`.
See [SECURITY.md](../../SECURITY.md) for development dependency audit notes.
