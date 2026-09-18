# compact-adviser judgment eval

Offline replay of the shipped compact-adviser checkpoint pipeline against your
own Pi session transcripts, plus a label rubric and a live TypeSafe Jev scorer.

The harness drives production `snapshot()` from `src/context.ts` through a
minimal fake `ExtensionContext`, and production `judge()` / `qualifies()` from
`src/judge.ts`. Request shape and the decision rule are not reimplemented.

**This directory ships the harness and the rubric, not a dataset.** Session
transcripts, checkpoints, worksheets, gold notes, results, and ablation output
stay in gitignored `eval/local/`. Do not commit them. Aggregate per-stratum
metrics for the shipped judge are in [`measured-results.md`](measured-results.md).

## Setup

1. Copy the corpus contract and point it at your sessions:

```sh
cp eval/corpus.example.json eval/local/corpus.json
```

Pi stores sessions under the agent directory, typically
`~/.pi/agent/sessions/<encoded-project-dir>/<timestamp>_<uuid>.jsonl`.
Each row is `{ "label", "stratum", "file" }`. `label` is an opaque id for
worksheets; `stratum` is your grouping (for example `interactive`, `coding`,
`longturn`). Override the path with `COMPACT_ADVISER_CORPUS`.

2. Run from `packages/pi-extension` so `../src/*.ts` resolves:

```sh
cd packages/pi-extension
node --import tsx eval/build.ts eval/local
```

`build.ts` writes `eval/local/checkpoints.jsonl` and `eval/local/worksheet/`.
Those files contain transcript text. Keep them local.

3. Score with a live TypeSafe key **from the environment only**. Do not pass the
key as argv, do not `export` it in the shell you type in, and do not print it.

```sh
node --import tsx eval/score.ts eval/local 1
python3 eval/metrics.py eval/local/labels.jsonl \
  eval/local/checkpoints.jsonl eval/local/results.jsonl
```

`score.ts` reads `TYPESAFE_API_KEY` from the environment. It uses a 60s timeout
so a slow call is measured rather than counted as a failure; production uses
2000ms. Latency is recorded per row so that gap is visible.

Optional provenance: `build.ts` marks rows whose snapshot state matches a logged
production request. It reads `~/.pi/agent/compact-adviser-requests.jsonl` unless
`COMPACT_ADVISER_REQUEST_LOG` is set. Enable request logging from
`/compact-adviser` first. The log is the redacted body; it never includes the
API key.

## Commands

| Script | What |
|---|---|
| `eval/build.ts` | Spread-sample checkpoints and write worksheets |
| `eval/build-targeted.ts` | Add minority-class rows marked `sampling=targeted-hard` |
| `eval/score.ts` | Live Jev through shipped `judge()` / `qualifies()` |
| `eval/metrics.py` | Per-class precision/recall vs gold, both gold definitions per stratum, task-boundary recall |
| `eval/compare.py` | Side-by-side two result files |
| `eval/fidelity.ts` | Replay vs a compact-adviser request log |
| `eval/verify-tokens.ts` | Fast usage total vs replayed context tokens |
| `eval/ablate.ts` | Synthetic coverage-flag variants (diagnostic) |
| `eval/stability.ts` | Repeat the same checkpoints |
| `eval/regate.ts` | Re-apply shipped `qualifies()` to stored results |
| `eval/rebuild.ts` | Re-replay snapshots with current `snapshot()` |
| `eval/bodycheck.ts` | Request-body size vs the 32kB cap |

One-off miners and probes live under `eval/tools/` (`mine.ts`, `mine2.ts`, `mine-memory.ts`, `probe-questions.ts`, `probe-phase-only.ts`, `retry.ts`). They are not part of the shipped scoring path.

## Label schema

One JSON object per checkpoint in `labels.jsonl`:

| Field | Values | Meaning |
|---|---|---|
| `id` | `cp001`, ... | Stable row id, aligned with checkpoints and worksheets |
| `phase_gold` | `completed_checkpoint` / `still_in_progress` / `unclear` | Gold for the shipped phase question |
| `continuation_gold` | `recoverable` / `needs_older_details` / `unclear` | Gold for reconstructibility (kept even though the shipped judge no longer asks this) |
| `safe_to_compact` | boolean | Hindsight product truth: would compacting *exactly here* have cost the work that actually followed |
| `pivot` | boolean | The next user turn introduced work unforeseeable at checkpoint time |
| `note` | string | Evidence. Describe structure; do not paste transcript quotes into anything that might be published |
| `task_boundary` | boolean | The checkpoint sits where one task ends and the next begins. Reported on its own because a judge can look healthy overall and still miss exactly these |
| `sampling` | `spread` / `targeted-hard` | On the checkpoint row. Targeted-hard is enriched: per-class recall is unbiased, precision is not |

Worksheets in `eval/local/worksheet/` show, per row, the judge's view (user
constraints + `recent` tail) beside the post-checkpoint future window. The
future window is labelling evidence the judge never sees.

## Gold-definition rubric

Follow the shipped phase criteria in `src/judge.ts`. Adjudicate with the
transcript *after* the checkpoint.

**`phase_gold`**

- `completed_checkpoint` when the assistant's own latest unit of work is
  finished and reported. Completeness follows who must act next: a question,
  choice, or blocker the assistant has fully stated and handed over is
  complete, even when the assistant says it will act once the answer arrives.
  Work the assistant merely *reports on* (another agent's task, an open pull
  request, a queued job, a decision that belongs to the user) is not the
  assistant's own work, and naming that work as open, running, parked, or
  awaited never makes the assistant's own phase unfinished. A status answer
  that fully answers what was asked is complete even when everything it
  describes is still open.
- `still_in_progress` when the assistant itself can take a next step now: its
  own verification, build, submission, or job is running right now, it promised
  to continue on its own, it is retrying, or it failed and left the failure
  unhandled.
- `unclear` when the transcript does not establish either. On long real
  sessions this class is often empty: the assistant either reports a finished
  unit or visibly owes work.

**`continuation_gold` - three-way rule**

Turns on where the answer demonstrably came from, and whether the snapshot
points at it:

- `needs_older_details` - the needed fact is conversational, and no artifact in
  `savedArtifacts` or the recent tail records it. Typical shape: the next user
  turn asks about a named option, figure, or decision that existed only in the
  older region, and the assistant answers with zero tool calls.
- `unclear` - the fact *is* durably recorded (a report, commit, or brief on
  disk), but nothing in the snapshot points at it, so post-compaction recovery
  depends on the assistant knowing to go looking.
- `recoverable` - the answer is in the recent tail, the user constraints, or an
  artifact the snapshot surfaces. Restated round instructions count as
  preserved, even when older messages were omitted.

**`safe_to_compact` vs the rubric conjunction**

`phase_gold == completed_checkpoint` AND `continuation_gold == recoverable` is
the rubric "should hint" label. `safe_to_compact` is the product question:
would compacting here have cost the user anything? On long rounds that restate
their own instructions every turn, those two answers can come apart. Report
both. Native `[COMPACTION]` events that land soon after a checkpoint and after
which the work continues are strong hindsight evidence for `safe_to_compact`.

## The two gold definitions

`metrics.py` reports both, per stratum, because they disagree and the
disagreement is the finding:

- **Product truth** - gold is `safe_to_compact`. A hint at a harmless moment
  counts as a hit even if the assistant was mid-task. This is the hindsight
  question: would compacting here have cost the user anything?
- **Contract** - should-hint is `completed_checkpoint` + safe; should-NOT-hint
  is `still_in_progress`. This is the judge's own stated question, and it is
  the only definition with a real negative class on the coding strata.

A stratum of mid-round checkpoints can score well under product truth purely
because a harness re-injects its instructions every turn, so nothing is lost by
compacting there. Read the contract table beside it before claiming the judge
recognises finished work. **Task-boundary recall is reported separately under
both definitions** and is the metric to watch: it measures the moments the
product exists to catch.

**`pivot`**

Mark true when the next user turn starts work that could not have been
predicted from checkpoint state (a new task, an unforeseeable back-reference,
a change of subject). Pivots flatter hindsight: compacting was "safe" only
because the next question had not been asked yet. Report metrics on all rows
and again with pivots excluded.

## Gitignore boundary

Tracked: the runner, `eval/tools/` (miners and probes), `corpus.example.json` /
`corpus.example.ts`, this README, `measured-results.md`, and `eval/local/.gitignore`.

Never commit: `eval/local/**` (except that gitignore file), `checkpoints*.jsonl`,
`results*.jsonl`, `ablation*.jsonl`, `worksheet/`, or any other session-derived
jsonl. The package-level and eval-level gitignores enforce this.

## Limits

The shipped product currently asks only the phase question. Continuation gold
and miners remain so a two-question contract can still be measured with
`eval/tools/probe-questions.ts`. Ablation variants overwrite coverage flags on real state;
they are a diagnostic, not real checkpoints.
