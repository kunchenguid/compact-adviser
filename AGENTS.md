# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- `VISION.md` at the repo root is the project's acceptance policy: what this product owns, what it refuses, and the accept/resist tests a change is measured against. Read it before proposing a feature or a policy change.
- The judge question set, `score()` and `floorFor()` must stay byte-identical across `packages/pi-extension/src/judge.ts`, `packages/claude-mod/lib/judge.ts`, `packages/codex-plugin/src/judge.ts`, and `packages/grok-plugin/lib/judge.ts`; the TypeSafe request/response log line builders in each package's `log.ts` must match, as must the `cooldownReason` gates in each package's `state.ts`, the redaction helpers in `context.ts`/`snapshot.ts`, `disable.ts`, and the judge-profile parser in `profile.ts`. `packages/pi-extension/test/lockstep.test.ts` and `test/profile.test.ts` enforce all of it across every host package. Tune every copy or none.
- Claude Code `$.env.get` takes a literal variable name, never a constant, and every name it reads must also be listed in `packages/claude-mod/scripts/validate.mjs` (`claude plugin validate --strict` compares them).
- Claude Code hooks cannot `import "node:fs"` and the plugin-test isolate has no `process`; `$.fs.write` replaces the whole file, so Claude writes one jsonl per session (`~/.claude/compact-adviser-requests-<sessionId>.jsonl`). Pi TypeSafe jsonl writes use `appendFileSync` (O_APPEND) in `packages/pi-extension/src/log.ts`.
- Every package README is generated from the root `README.md`; never hand-edit them. See "Package READMEs" in `CONTRIBUTING.md` for the mechanism (`scripts/generate-package-readme.mjs`, `npm run sync-readmes`, and the drift checks in each package's `check`).
- CI: `.github/workflows/ci.yml` runs a `check-*` and an `e2e-*` job per host package on push/PR. Pin every host binary in `.github/host-versions.env`.
- Grok host facts, measured against 1.0.34 and asserted by `packages/grok-plugin/scripts/live-e2e.mjs`: Grok lists a plugin's `hooks/hooks.json` but never loads it into a session, so `compact-adviser install` registers the same handlers in `${GROK_HOME:-~/.grok}/hooks/`; the status row is the only hint surface and only the user's own `config.toml` can enable it; `signals.json` field names are undocumented, so unreadable usage takes the strictest floor. The e2e drives the real `grok agent … stdio` offline through `--xai-api-base-url` plus `XAI_API_KEY`, answering the OpenAI Responses API shape. `lastPromptId` skips a later serial Stop of the same turn but is not an atomic claim, so concurrent plugin+user-hook starts can both ask TypeSafe; follow up with a session-state claim only if Grok starts loading plugin hooks (live-e2e would then see `hook_count` above 6).
- `packages/grok-plugin` ships as TypeScript with no build step and no dependencies: Node's own type stripping runs it, so nothing there may use non-erasable syntax (no enums, no constructor parameter properties).
- Release: release-please at repo root with extra-files version bumps; `npm publish --access public --provenance` from `packages/pi-extension` via GitHub OIDC. No `NPM_TOKEN`. See `CONTRIBUTING.md`.
- Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
