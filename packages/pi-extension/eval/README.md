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
python3 eval/metrics.py eval/local/labels.jsonl \
  eval/local/checkpoints.jsonl eval/local/results.jsonl 0.6   # re-gate at a floor
python3 eval/tools/schedule.py eval/local/labels.jsonl eval/local/results.jsonl \
  "p['done']['finished']*(0.5+0.5*p['shape']['hands_on'])" 0.4 0.5 0.6 0.7 0.8 0.9
```

`score.ts` reads `TYPESAFE_API_KEY` from the environment. It uses a 60s timeout
so a slow call is measured rather than counted as a failure; production uses
2000ms. Latency is recorded per row so that gap is visible. Each result row
carries both answers (`doneP`, `shapeP`) and the composed `score`; `hint` and
`auto` are the gate at one reference context usage (third argument, default
0.5, floor 0.80), and `metrics.py` or `schedule.py` re-gate from `score` at any
floor, so one live run measures the whole usage-dependent ladder.

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
| `eval/score.ts` | Live Jev through shipped `judge()` / `score()` / `qualifies()`; records both answers and the composed score, gates at a reference usage (default 0.5) |
| `eval/metrics.py` | Per-class precision/recall vs gold, both gold definitions per stratum, task-boundary recall |
| `eval/compare.py` | Side-by-side two result files |
| `eval/fidelity.ts` | Replay vs a compact-adviser request log |
| `eval/verify-tokens.ts` | Fast usage total vs replayed context tokens |
| `eval/ablate.ts` | Synthetic coverage-flag variants (diagnostic) |
| `eval/stability.ts` | Repeat the same checkpoints |
| `eval/regate.ts` | Re-apply shipped `score()` / `qualifies()` to stored results at a usage |
| `eval/rebuild.ts` | Re-replay snapshots with current `snapshot()` |
| `eval/bodycheck.ts` | Request-body size vs the 32kB cap |
| `eval/tools/audit_followups.py` | Render per-checkpoint audit sheets: judge view beside the real post-checkpoint user turns and how each was served |
| `eval/tools/mine_followups.py` | Find settled turns followed by a real user turn served from memory (candidates for `older` negatives) |
| `eval/tools/tail_has.py` | Provenance check: is a phrase anywhere in the judge-visible snapshot |
| `eval/tools/audit_stats.py` | Join gold labels with audit labels and print flips, class counts, natural experiments |
| `eval/tools/probe-gate.ts` | Send an arbitrary questions block (optionally merged with the shipped questions, `--with-shipped`) and keep every answer |
| `eval/tools/gate_sweep.py` | Sweep hint gates offline over a `probe-gate.ts` output: product, contract, older-FP and boundary recall |
| `eval/tools/curve.py` | ROC AUC, average precision and a floor ladder (precision/recall per floor) for any probed question against `safe_to_compact` |
| `eval/tools/blend.py` | The same curve for an arbitrary expression over one probe's probability vectors, for blended or multi-question scores |
| `eval/tools/schedule.py` | Per-floor fires, product and contract precision/recall, older-FP and boundary recall for one score, to read a usage-dependent floor schedule off the set |
| `eval/tools/hill.py` | AUC, AP and floor ladder for several probes of one question key, with a fixed dev/holdout split, for hill-climbing a prompt |
| `eval/tools/earn.py` | Paired bootstrap of AP and AUC differences against a base probe: does an added clause earn its place |

One-off miners and probes live under `eval/tools/` (`mine.ts`, `mine2.ts`, `mine-memory.ts`, `probe-questions.ts`, `probe-phase-only.ts`, `retry.ts`). They are not part of the shipped scoring path.

## Label schema

One JSON object per checkpoint in `labels.jsonl`:

| Field | Values | Meaning |
|---|---|---|
| `id` | `cp001`, ... | Stable row id, aligned with checkpoints and worksheets |
| `phase_gold` | `completed_checkpoint` / `still_in_progress` / `unclear` | Gold for the shipped phase question |
| `continuation_gold` | `recoverable` / `needs_older_details` / `unclear` | Gold for reconstructibility (kept even though the shipped judge no longer asks this) |
| `safe_to_compact` | boolean | Hindsight product truth: would compacting *exactly here* have cost the work that actually followed. Since v4 this is derived: `context_need != older` |
| `pivot` | boolean | The next user turn introduced work unforeseeable at checkpoint time |
| `note` | string | Evidence. Describe structure; do not paste transcript quotes into anything that might be published |
| `task_boundary` | boolean | The checkpoint sits where one task ends and the next begins. Reported on its own because a judge can look healthy overall and still miss exactly these |
| `sampling` | `spread` / `targeted-hard` / `targeted-followup` | On the checkpoint row. Targeted arms are enriched: per-class recall is unbiased, precision is not. `targeted-followup` rows were mined for a real user follow-up after a claimed completion |
| `followup_kind` | `new_task` / `verdict` / `why` / `revise` / `status` / `continue` | Behaviour-based (v4): what the first substantive user turn after the checkpoint actually asked for |
| `context_need` | `none` / `tail` / `artifact` / `older` | Behaviour-based (v4): where the assistant demonstrably served that follow-up from. `older` is the only class a compaction would have hurt |
| `origin` | `v3` / `v4-mined` | Whether the row survived from the earlier set or was mined for the behaviour audit |

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

## Behaviour-based rubric (v4)

The earlier rubric judged a checkpoint from its snapshot plus a short future
window. The v4 pass relabelled every row from what the user actually did next,
because the product question is not "was the unit finished" but "did prior
context turn out to be an asset or a burden". `eval/tools/audit_followups.py`
renders the sheets; `eval/tools/tail_has.py` checks provenance.

**Episode.** The first substantive user turn after the checkpoint plus the
turns that immediately follow on the same thread. Harness injections (watcher
wakes, hook output, slash-command expansions) are skipped; a relay ring that
carries a human instruction counts as a user turn. A recap command (`/ahoy`)
is its own class, not a negative: the recap answer is served from memory by
design, so only the human's next real question is judged. Rows with no
observed user turn (session end, autonomous loops) cannot carry a
behaviour label and are dropped from v4; measure them under the contract
definition instead.

**`followup_kind`**: what that turn asked for. `verdict` is an answer to a
choice the assistant handed over; `why` is any explanation, justification, or
clarification request; `revise` changes delivered work; `status` asks where
something stands or what happened; `continue` resumes the same unit;
`new_task` starts an independent one.

**`context_need`**: where the assistant demonstrably served it from.

- `none` - nothing from the conversation was needed.
- `tail` - the answer's substance is inside the judge-visible snapshot (recent
  tail, user constraints, listed artifacts). Treated as safe: a compaction
  summary preserves the current exchange best, and the checkpoint message that
  defines a handed choice is the tail.
- `artifact` - the assistant re-read a file, pull request, status record, or
  log before answering. Safe: recovery does not depend on memory.
- `older` - a zero-tool (or tool-irrelevant) answer whose facts are absent from
  the snapshot, or a brief or dispatch written from memory with no re-read.
  Verify with `tail_has.py` that the key figures, names, or option definitions
  really are missing from `recent`, `userConstraints`, `previousSummary`, and
  `savedArtifacts` before labelling `older`.

`safe_to_compact` is `context_need != older`. `continuation_gold` is derived
the same way for v4 rows. A native `[COMPACTION]` that lands right after a
checkpoint is a natural experiment: record whether the next answer survived it.

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

The shipped product asks two atomic questions, `done` and `shape`, and
composes them in code. Continuation gold and miners remain so other question
sets can still be measured with `eval/tools/probe-questions.ts` (legacy
`phase`-shaped answers) or `eval/tools/probe-gate.ts`.

The `older` class is not predictable from the stopping state. Three
single-question alternatives ("will the next ask need earlier detail",
"is older history an asset or a burden", "is a handed choice restated") were
probed on the v4 set: each separated `older` rows from the rest at an AUC of
about 0.6, and none beat the phase gate on precision without collapsing
recall. The judge cannot see what lies outside the snapshot, so a why or
status question about an earlier thread looks like any other completed
checkpoint. Treat the phase gate's false positives on that class as a floor
that no question rewrite removes.

The usage-dependent floor changes what to optimise: not one operating point
but the whole precision/recall ladder of a score, since the floor slides with
`usage.tokens / usage.contextWindow`. Measured with `eval/tools/curve.py` on
v4, the previous single phase probability ranked safe checkpoints at AUC 0.57
(AP 0.81). Hill-climbing from a one-sentence seed (`eval/tools/hill.py`,
`earn.py`), the best single four-way question reached AP 0.82 / AUC 0.65 but
kept a step in its ladder. The shipped pair, `done` (finished / not finished)
and `shape` (hands-on / coordinating) in the same request, composed in code as
P(finished) x (0.5 + 0.5 P(hands_on)), re-scored through the shipped
`judge()` / `score()` on all 136 rows: AP 0.84 / AUC 0.65, precision / recall
91 % / 20 % at floor 0.90, 86 % / 43 % at 0.70, 77 % / 78 % at 0.50, 73 % / 90 %
at 0.40; on the 96 rows sampled as they occur (16 % unsafe): 100 % / 22 %,
95 % / 43 %, 83 % / 77 %, 83 % / 89 %. That matches TypeSafe's guidance
(decompose atomically, ask all questions in one request, compose in code); a
question that folds two judgments into one choice measured worse every time,
and a clause saying that only merged or committed code counts as done lowered
AP and recall on open-pull-request completions.

Ablation variants overwrite coverage flags on real state; they are a
diagnostic, not real checkpoints.
