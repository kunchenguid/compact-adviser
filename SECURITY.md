# Security and verification boundaries

## Conversation data

The Pi extension, Claude Code mod, Codex plugin, and Grok Build plugin send selected conversation text to the selected judge when the package is installed, its key is available, and the other product gates pass (mode, minimum context, idle session). See the [README](README.md#environment-variables) for provider selection and key sources.
Installing the package is that consent; there is no separate sharing toggle.
For the default provider, the [documented `TYPESAFE_BASE` override](README.md#environment-variables) changes where both context and its key are sent. Its HTTPS or loopback-only HTTP restriction prevents sending the key over the network in cleartext. A host's own trusted project configuration can still set launch environment variables, as it can already run hooks.
Pi and Claude Code can save a TypeSafe key from their settings UI. Codex uses an external settings CLI. Grok can save one only through the shell CLI outside Grok, because Grok appends slash-command arguments to the model. A saved key lives with mode and threshold in the implementation's settings store, with file permissions as restrictive as the host allows.
It is never shown after save, and never written to logs, status lines, error messages, or judge request bodies, including when the agent reads the settings file.

The [README's data boundary](README.md#what-is-sent-to-the-selected-judge) lists included and excluded data, destinations, the request cap, and authentication handling.
Redaction of known key patterns and obvious sensitive-file results is best-effort, not a guarantee; do not keep this package loaded for material that must not leave the machine.
Errors, timeouts, malformed responses, and contradictory factors never substitute an affirmative judgment.

Automatic compaction on Pi and Claude Code is experimental and lossy; Codex and Grok are hint-only because an outside process cannot trigger `/compact` in their running sessions.
A high model probability is not proof of preservation or continuation quality.
Hint mode is the default; the host's own compaction path and other extensions' hooks remain authoritative.

## Experimental Decisions provider

Provider opt-in, credentials, and fallback behavior are defined in the [Decisions setup](README.md#openai-decisions-experimental).

The selected key and already-known inactive launch/saved keys are included in best-effort snapshot redaction. The request cap applies after nested JSON escaping, so a Decisions request may be rejected even when its TypeSafe equivalent fits. Accepted responses are capped at 32,768 bytes. Any refused or malformed answer rejects the whole judgment. Probability values and the existing score/floor policy are not recalibrated. Quota/spend errors are distinguished from transient rate limits without printing raw API errors. [Local logging](docs/product-contract.md#semantics) never stores authorization headers.

Pi, Codex, and Grok bound response stream accumulation and reject redirects; their existing two-second deadlines cancel the request. Claude Code exposes already-materialized response text and no redirect or abort control: its deadline bounds waiting, not the host's network operation or response allocation. Its accepted response size is still checked. The loopback-only regression endpoint in Claude, Codex, and Grok also applies to Decisions fixtures; do not set it in normal use.

Decisions remains opt-in and experimental. Deterministic integration tests and synthetic live requests do not establish equivalent compaction accuracy, calibration, or the alternative-judge evaluation bar in VISION.md. No real-session quality result is claimed for this provider.

## Package separation

The Pi implementation lives only in `packages/pi-extension` and owns its Pi-specific configuration and session entries.
The Claude Code implementation lives only in `packages/claude-mod` and owns its `userConfig` options and plugin store.
The Codex implementation lives only in `packages/codex-plugin` and owns its settings, session records, and request logs under `<CODEX_HOME>/compact-adviser/`.
The Grok implementation lives only in `packages/grok-plugin` and owns its settings, per-session state, verdicts, diagnostics, and request logs under `${GROK_HOME:-~/.grok}/compact-adviser/`.
No implementation loads another's runtime or reads another's storage.

## Verified hosts

Verified on 2026-09-17 against the actual **Pi 0.85.1**, **Claude Code 2.1.275**, **Codex CLI 0.153.4**, and **Grok Build 1.0.34** host runtimes.
The Pi extension API floor remains 0.82.0; the Claude Code mods API is early access and default-off; the Codex plugin requires Node 22.18 or newer and Codex CLI 0.153.0 or newer, and is supported on macOS and Linux. The Grok adapter requires Node 22.18 or newer.
The Claude Code module is a complete no-op unless `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is exactly `1`.
Requests from the mod go through Claude Code's host fetch (`$.http.fetch`), with the transport limits described [above](#experimental-decisions-provider).
Codex requests use Node's `fetch` from the hook process.
Besides `TYPESAFE_BASE`, the only endpoint override, `COMPACT_ADVISER_TEST_ENDPOINT`, exists for the live regressions and is ignored unless it is an `http://127.0.0.1:<port>/` URL.
The automatic-mode acknowledgement is kept in the plugin's own store, not in `/config`, so experimental auto cannot be granted without the disclosure dialog. A legacy `sharingConsent` field in that store is ignored.

The Pi, Codex, and Grok clients reject redirects from the selected judge endpoint.
The user's Pi, Claude Code, Codex, or Grok installation is independently managed.

## Development SDK

The Pi package's development SDK is pinned to **Pi 0.85.1**, matching the verified runtime.
At verification on 2026-09-17, `npm audit` in `packages/pi-extension` reported 0 vulnerabilities.
The Claude Code mod, Codex plugin, and Grok plugin have no runtime dependencies; their development dependencies are limited to type-checking, linting, and Node type definitions.

Install Pi runtime dependencies with `--omit=dev --omit=peer` when using Pi's bundled modules.
The user's Pi provides the core modules at runtime; this repository does not bundle or update that shared installation.
Development dependencies can be revisited when upgrading the supported API baseline, with real-runtime compatibility tests kept green.

## Tests versus model accuracy

The native integration tests use the real Pi executable, Claude Code TUI, Codex TUI, or Grok agent, isolated configuration directories, and deterministic provider and judge fixtures.
They prove API/UI integration, cancellation, and local safety conditions without exposing account credentials or conversation data.
They do not establish live judge precision or continued task quality after a real generated summary.
