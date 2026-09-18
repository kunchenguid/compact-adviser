# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- The judge question set, `score()` and `floorFor()` must stay byte-identical in `packages/pi-extension/src/judge.ts` and `packages/claude-mod/lib/judge.ts`; OpenRouter request/response log line builders in each package's `log.ts` must match too; `cooldownReason` gates in each package's `state.ts` must match. `packages/pi-extension/test/lockstep.test.ts` enforces all three. Tune both or neither.
- Claude Code hooks cannot `import "node:fs"` and the plugin-test isolate has no `process`; `$.fs.write` replaces the whole file, so Claude writes one jsonl per session (`~/.claude/compact-adviser-requests-<sessionId>.jsonl`). Pi OpenRouter jsonl writes use `appendFileSync` (O_APPEND) in `packages/pi-extension/src/log.ts`.
- Judge design rule, measured: two one-sentence atomic questions composed in code beat any single question that folds two judgments together (TypeSafe's own guidance). Hill-climb prompt changes with `eval/tools/earn.py` (paired bootstrap) and read the usage-floor ladder with `eval/tools/schedule.py`; a clause stays only if it earns its place.
- Judgment eval harness: `packages/pi-extension/eval/`. Session transcripts, labels, worksheets, and results stay in gitignored `eval/local/`. See that README for the corpus contract and label rubric.
- Both package READMEs are generated from the root `README.md`; never hand-edit them. See "Package READMEs" in `CONTRIBUTING.md` for the mechanism (`scripts/generate-package-readme.mjs`, `npm run sync-readmes`, and the drift checks in each package's `check`).
- CI: `.github/workflows/ci.yml` runs `check-pi`, `check-claude-mod`, `e2e-pi`, and `e2e-claude-mod` on push/PR. Pin Pi and Claude Code in `.github/host-versions.env`.
- Release: release-please at repo root with extra-files version bumps; `npm publish --access public --provenance` from `packages/pi-extension` via GitHub OIDC. No `NPM_TOKEN`. See `CONTRIBUTING.md`.
- PRs targeting `main` go through `no-mistakes`; do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
