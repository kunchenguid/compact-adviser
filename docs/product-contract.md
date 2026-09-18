# Shared product contract

This is a documentation contract, not a shared runtime or install-state layer.
Each harness implementation owns its event handling, dependencies, installation, configuration location, and session state.

## Semantics

- Modes: `hint` (default), `auto` (explicit experimental opt-in), and `off`.
A host that gives no process outside the session a way to run `/compact` ships `hint` and `off`
only, and says so rather than offering an `auto` it cannot honour. Codex is such a host.
- Hint text: Pi and Codex display **Compact adviser: work appears completed or recorded. Run /compact to save tokens.** Claude Code's host adds **compact-adviser:**, so the mod supplies only **work appears completed or recorded. Run /compact to save tokens.**
- `minContextTokens` defaults to the constant **40000**, is configurable and persists with the selected mode.
There is no percentage-of-context-window condition.
- A size threshold makes a checkpoint eligible for judgment; it does not order compaction.
- Inspect cheap local state before any TypeSafe Jev request.
- TypeSafe/Jev snapshots consider up to the last 64 transcript messages, including tool results, clipped by existing byte budgets (about 14kB recent tail, per-message caps, 8kB user-constraint budget, and a 32kB request refuse path). Message count is not the tight payload bottleneck.
- Long tool-result dumps keep a head and tail slice with an explicit middle omission marker so one result cannot consume the tail budget.
- Optional TypeSafe request logging is off by default and can be enabled from the host's compact-adviser settings surface. When on, each request body and the matching Jev outcome are appended to a local jsonl log: successful outcomes include answers, score, usage, floor, and qualifies; failures include only a sanitized error kind. Existing secret redaction applies, and the log never includes the API key. Pi uses one shared O_APPEND file; Claude writes one file per session (`compact-adviser-requests-<session-id>.jsonl`) because its host cannot atomically append. Codex writes the same per-session file name with O_APPEND.
- Judge whether known next work can continue without exact older details, not whether context is merely large.
- One judgment decides both hint and auto: two atomic Jev questions in one request, `done` (is the assistant's own latest unit finished) and `shape` (is this conversation hands-on work or coordination), composed in code as score = P(finished) x (0.5 + 0.5 x P(hands_on)). The score must clear a floor that depends on context usage (tokens over the model's window): 0.90 while usage is at most 10 %, 0.50 from 90 % on, and a linear ramp between (floor = 0.90 - 0.5 x (usage - 0.10), rounded to three decimals); unknown usage takes the strictest floor. Auto is not a higher bar. Mode only chooses what happens after a qualifying judgment (hint vs compact). Experimental auto still requires the existing first-use acknowledgement to turn auto on. Measured on the judgment-eval set against what users actually asked next: 95 % precision at 19 % recall at the strict end, 74 % / 91 % at the loose end, with no cliff between. A question that asked Jev to judge finished-and-hands-on in one step, and a companion "would older detail be lost" question, both measured worse and were not kept.
- `COMPACT_ADVISER_DISABLE` is a per-session kill switch. Set to `1`, `true`, `yes` or `on` (case-insensitive, surrounding whitespace ignored), it makes the product take no action for that process: no TypeSafe/Jev request, no hint, no automatic compaction, no command, and no status-line output that depends on a judgment. It wins over a saved `hint` or `auto` mode and over every other enablement path. Any other value, including unset, leaves behavior unchanged. Each supported host reads it once per session, since a session's environment is fixed. Pi, Claude, and Codex parse it through a byte-identical `disable.ts`. Pi returns from install before registering hooks or `/compact-adviser`. Codex returns from the hook and CLI process before judging or running a command.
- Non-interactive sessions stay inert when that can be detected reliably. Pi requires `mode === "tui"` with a UI; the Claude Code mod requires the host's `session.start` `isInteractive` flag and returns before command registration, session-record pruning, pending-save toasts, and compaction cooldown writes. Codex reads the rollout's `originator`. No host guesses from `CI` or similar ambient variables.
- Uncertain, stale, interrupted, or failed judgments leave context alone. A host whose only user-facing channel is permanent (Codex's hook output becomes a scrollback line that cannot be cleared) reports such a failure nowhere and simply backs off.
- Installing or loading the package is consent to send eligible checkpoint context to TypeSafe when a key is available and other product gates pass (mode, minimum context, idle session, and so on). A TypeSafe API key may be entered through the host's compact-adviser settings surface and stored in the same settings store as mode and threshold; after save the UI reports only presence or key source (`env` / `saved` / `.env` / `missing`), never the value. A non-empty launch-environment value wins over the saved key, which wins over a cwd `.env`.
- There is no separate sharing toggle. A saved `sharingConsent` value from an older version is ignored.
- Native compaction remains authoritative and lossy; no timing model promises perfect preservation.
- Configuration changes do not immediately compact.
Invalid values and cancellation preserve existing settings; failed saves are reported.

## Implementations

| Package | State | Installation |
| --- | --- | --- |
| `packages/pi-extension` | Pi implementation | Install this package path with `pi install` |
| `packages/claude-mod` | Claude Code mod (early-access function-hooks API) | Load this package path with `claude --plugin-dir` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` |
| `packages/codex-plugin` | Codex CLI plugin, hint-only | `codex plugin marketplace add` this repository, then `codex plugin add compact-adviser@compact-adviser` |

Pi uses its own agent-directory `compact-adviser.json` and Pi session custom entries.
The Claude Code mod uses its own `userConfig` options (`mode`, `minContextTokens`, `logRequests`, `typesafeApiKey`) in Claude Code's settings, and its own plugin store for the automatic-mode acknowledgement and per-session cooldowns.
`typesafeApiKey` is hidden from `/config` so the host menu never draws the secret.
The Codex plugin owns `<CODEX_HOME>/compact-adviser/`: one `settings.json`, one cooldown record
per session, and the request logs. It does not touch `config.toml`, whose unknown keys are an
error under `--strict-config`, and it has no `auto` mode or acknowledgement to store.
Snooze and dismiss are a known gap: Codex gives neither the hook nor the CLI a reliable
current-session identity, so the CLI could only mutate the most recently written session record.
No implementation reads or mutates another's records.
No harness installs or loads another harness's runtime.
