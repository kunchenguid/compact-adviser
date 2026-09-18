# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- The judge question set must stay byte-identical in `packages/pi-extension/src/judge.ts` and `packages/claude-mod/lib/judge.ts`; `packages/pi-extension/test/lockstep.test.ts` enforces it. Tune both or neither.
- Judgment eval harness: `packages/pi-extension/eval/`. Session transcripts, labels, worksheets, and results stay in gitignored `eval/local/`. See that README for the corpus contract and label rubric.
- CI: `.github/workflows/ci.yml` runs `check-pi`, `check-claude-mod`, `e2e-pi`, and `e2e-claude-mod` on push/PR. Pin Pi and Claude Code in `.github/host-versions.env`.
- Release: release-please at repo root with extra-files version bumps; `npm publish --access public --provenance` from `packages/pi-extension` via GitHub OIDC. No `NPM_TOKEN`. See `CONTRIBUTING.md`.
- PRs targeting `main` go through `no-mistakes`; do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
