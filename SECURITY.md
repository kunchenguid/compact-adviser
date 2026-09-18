# Security and verification boundaries

## Conversation data

The Pi extension, Claude Code mod, and Codex plugin send selected conversation text to TypeSafe when the package is installed, a key is available from the launch environment, a settings-saved value, or `TYPESAFE_API_KEY` in a `.env` file in the working directory, and the other product gates pass (mode, minimum context, idle session).
Installing the package is that consent; there is no separate sharing toggle.
A settings-saved key is stored in the same settings file as mode and threshold, with file permissions as restrictive as the host allows.
It is never shown after save, and never written to logs, status lines, error messages, or TypeSafe request bodies, including when the agent reads the settings file.

| Sent to `https://api.typesafe.ai/v1/systemone` | Not sent |
| --- | --- |
| Bounded user constraints, up to the last 64 visible replies and tool results (clipped), short tool-result excerpts, an existing summary, saved-artifact names, omission markers | System prompts, hidden reasoning, images, environment variables, the API key, complete transcripts |

Redaction of known key patterns and obvious sensitive-file results is best-effort, not a guarantee; do not keep this package loaded for material that must not leave the machine.
Requests are capped at 32,000 serialized UTF-8 bytes.
Errors, timeouts, malformed responses, and contradictory factors never substitute an affirmative judgment.

Automatic compaction on Pi and Claude Code is experimental and lossy; Codex is hint-only.
A high model probability is not proof of preservation or continuation quality.
Hint mode is the default; the host's own compaction path and other extensions' hooks remain authoritative.

## Package separation

The Pi implementation lives only in `packages/pi-extension` and owns its Pi-specific configuration and session entries.
The Claude Code implementation lives only in `packages/claude-mod` and owns its `userConfig` options and plugin store.
The Codex implementation lives only in `packages/codex-plugin` and owns its settings, session records, and request logs under `<CODEX_HOME>/compact-adviser/`.
No implementation loads another's runtime or reads another's storage.

## Verified hosts

Verified on 2026-09-17 against the actual **Pi 0.85.1**, **Claude Code 2.1.275**, and **Codex CLI 0.153.4** host runtimes.
The Pi extension API floor remains 0.82.0; the Claude Code mods API is early access and default-off; the Codex plugin requires Node 22.18 or newer and Codex CLI 0.153.0 or newer, and is supported on macOS and Linux.
The Claude Code module is a complete no-op unless `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is exactly `1`.
Requests from the mod go through Claude Code's host fetch (`$.http.fetch`), which does not expose redirect control to plugins; the fixed endpoint is `https://api.typesafe.ai/v1/systemone`.
Codex requests use Node's `fetch` from the hook process.
The only endpoint override, `COMPACT_ADVISER_TEST_ENDPOINT`, exists for the live regressions and is ignored unless it is an `http://127.0.0.1:<port>/` URL.
The automatic-mode acknowledgement is kept in the plugin's own store, not in `/config`, so experimental auto cannot be granted without the disclosure dialog. A legacy `sharingConsent` field in that store is ignored.

The Pi client rejects redirects on the same fixed HTTPS endpoint.
The user's Pi, Claude Code, or Codex installation is independently managed.

## Development SDK

The Pi package's development SDK is pinned to **Pi 0.85.1**, matching the verified runtime.
At verification on 2026-09-17, `npm audit` in `packages/pi-extension` reported 0 vulnerabilities.
The Claude Code mod's development dependencies are TypeScript and Biome; the Codex plugin also carries Node type definitions. Neither has a runtime dependency.

Install Pi runtime dependencies with `--omit=dev --omit=peer` when using Pi's bundled modules.
The user's Pi provides the core modules at runtime; this repository does not bundle or update that shared installation.
Development dependencies can be revisited when upgrading the supported API baseline, with real-runtime compatibility tests kept green.

## Tests versus model accuracy

The native integration tests use the real Pi executable, Claude Code TUI, or Codex TUI, isolated configuration directories, and deterministic provider and TypeSafe fixtures.
They prove API/UI integration, cancellation, and local safety conditions without exposing account credentials or conversation data.
They do not establish live Jev precision or continued task quality after a real generated summary.
