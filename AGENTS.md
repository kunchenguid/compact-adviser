# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- The judge question set, `score()` and `floorFor()` must stay byte-identical across `packages/pi-extension/src/judge.ts`, `packages/claude-mod/lib/judge.ts` and `packages/codex-plugin/src/judge.ts`; the TypeSafe request/response log line builders in each package's `log.ts` must match, as must the `cooldownReason` gates in each package's `state.ts`, the redaction helpers in `context.ts`/`snapshot.ts`, and `disable.ts`. `packages/pi-extension/test/lockstep.test.ts` enforces all of it across all three. Tune every copy or none.
- Claude Code `$.env.get` takes a literal variable name, never a constant, and every name it reads must also be listed in `packages/claude-mod/scripts/validate.mjs` (`claude plugin validate --strict` compares them).
- Claude Code hooks cannot `import "node:fs"` and the plugin-test isolate has no `process`; `$.fs.write` replaces the whole file, so Claude writes one jsonl per session (`~/.claude/compact-adviser-requests-<sessionId>.jsonl`). Pi TypeSafe jsonl writes use `appendFileSync` (O_APPEND) in `packages/pi-extension/src/log.ts`.
- Judge design rule, measured: two one-sentence atomic questions composed in code beat any single question that folds two judgments together (TypeSafe's own guidance). Hill-climb prompt changes with `eval/tools/earn.py` (paired bootstrap) and read the usage-floor ladder with `eval/tools/schedule.py`; a clause stays only if it earns its place.
- Judgment eval harness: `packages/pi-extension/eval/`. Session transcripts, labels, worksheets, and results stay in gitignored `eval/local/`. See that README for the corpus contract and label rubric.
- The package READMEs are generated from the root `README.md`; never hand-edit them. See "Package READMEs" in `CONTRIBUTING.md` for the mechanism (`scripts/generate-package-readme.mjs`, `npm run sync-readmes`, and the drift checks in each package's `check`).
- CI: `.github/workflows/ci.yml` runs a `check-*` and an `e2e-*` job per host package on push/PR. Pin every host binary in `.github/host-versions.env`.
- Codex adapter (`packages/codex-plugin`, hint-only: nothing outside a Codex session can run `/compact`). Its sources are TypeScript that plain `node` type-strips, so they must stay erasable - no parameter properties, no enums. Codex rebuilds a hook's PATH from a shell snapshot and may have no `node` on it, so hooks go through `hooks/run.sh`, which is silent when it finds none. Judging is gated to the interactive TUI by the rollout's `originator`. The rollout transcript format is explicitly unstable upstream: `src/rollout.ts` never throws and degrades to the strictest floor. `scripts/validate.mjs` checks the package is loadable exactly as shipped. Snooze/dismiss are a known gap and follow-up: suppressing advice safely needs a reliable current-session identity that Codex gives neither the hook nor the CLI, so the CLI could only mutate the most recently written session record. Windows support is a possible follow-up: this ship is macOS and Linux only because the hooks run through POSIX `sh` and have no `commandWindows` entries.
- Release: release-please at repo root with extra-files version bumps; `npm publish --access public --provenance` from `packages/pi-extension` via GitHub OIDC. No `NPM_TOKEN`. See `CONTRIBUTING.md`.
- PRs targeting `main` go through `no-mistakes`; do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
