# Shared product contract

This is a documentation contract, not a shared runtime or install-state layer.
Each harness implementation owns its event handling, dependencies, installation, configuration location, and session state.

## Semantics

- Modes: `hint` (default), `auto` (explicit experimental opt-in), and `off`.
- Hint text: **Compact adviser: work appears completed or recorded. Run /compact to save tokens.**
- `minContextTokens` defaults to the constant **40000**, is configurable and persists with the selected mode.
There is no percentage-of-context-window condition.
- A size threshold makes a checkpoint eligible for judgment; it does not order compaction.
- Inspect cheap local state before any TypeSafe Jev request.
- TypeSafe/Jev snapshots consider up to the last 64 transcript messages, including tool results, clipped by existing byte budgets (about 14kB recent tail, per-message caps, 8kB user-constraint budget, and a 32kB request refuse path). Message count is not the tight payload bottleneck.
- Long tool-result dumps keep a head and tail slice with an explicit middle omission marker so one result cannot consume the tail budget.
- Optional TypeSafe request logging is off by default and can be enabled from the compact-adviser settings menu. When on, each request body and the matching Jev outcome are appended to a local jsonl log: successful outcomes include answers, score, usage, floor, and qualifies; failures include only a sanitized error kind. Existing secret redaction applies, and the log never includes the API key. Pi uses one shared O_APPEND file; Claude writes one file per session (`compact-adviser-requests-<session-id>.jsonl`) because its host cannot atomically append.
- Judge whether known next work can continue without exact older details, not whether context is merely large.
- One judgment decides both hint and auto: two atomic Jev questions in one request, `done` (is the assistant's own latest unit finished) and `shape` (is this conversation hands-on work or coordination), composed in code as score = P(finished) x (0.5 + 0.5 x P(hands_on)). The score must clear a floor that depends on context usage (tokens over the model's window): 0.90 while usage is at most 10 %, 0.50 from 90 % on, and a linear ramp between (floor = 0.90 - 0.5 x (usage - 0.10), rounded to three decimals); unknown usage takes the strictest floor. Auto is not a higher bar. Mode only chooses what happens after a qualifying judgment (hint vs compact). Experimental auto still requires the existing first-use acknowledgement to turn auto on. Measured on the judgment-eval set against what users actually asked next: 95 % precision at 19 % recall at the strict end, 74 % / 91 % at the loose end, with no cliff between. A question that asked Jev to judge finished-and-hands-on in one step, and a companion "would older detail be lost" question, both measured worse and were not kept.
- Uncertain, stale, interrupted, or failed judgments leave context alone.
- Installing or loading the package is consent to send eligible checkpoint context to TypeSafe when a key is available and other product gates pass (mode, minimum context, idle session, and so on). A TypeSafe API key may be entered in the compact-adviser menu and stored in the same settings store as mode and threshold; after save the UI reports only presence or key source (`env` / `saved` / `.env` / `missing`), never the value. A non-empty launch-environment value wins over the saved key, which wins over a cwd `.env`.
- There is no separate sharing toggle. A saved `sharingConsent` value from an older version is ignored.
- Native compaction remains authoritative and lossy; no timing model promises perfect preservation.
- Configuration changes do not immediately compact.
Invalid values and cancellation preserve existing settings; failed saves are reported.

## Implementations

| Package | State | Installation |
| --- | --- | --- |
| `packages/pi-extension` | Pi implementation | Install this package path with `pi install` |
| `packages/claude-mod` | Claude Code mod (early-access function-hooks API) | Load this package path with `claude --plugin-dir` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` |

Pi uses its own agent-directory `compact-adviser.json` and Pi session custom entries.
The Claude Code mod uses its own `userConfig` options (`mode`, `minContextTokens`, `logRequests`, `typesafeApiKey`) in Claude Code's settings, and its own plugin store for the automatic-mode acknowledgement and per-session cooldowns.
`typesafeApiKey` is hidden from `/config` so the host menu never draws the secret.
Neither implementation reads or mutates the other's records.
No harness installs or loads the other harness's runtime.
