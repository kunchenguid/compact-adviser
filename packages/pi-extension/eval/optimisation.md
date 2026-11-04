# Cached profile optimisation

This workflow tunes numeric judge profiles against session-grouped data.
It does not change the runtime judge or send transcripts to an optimisation service.
The optional runtime profile is described in [Judge profiles](../../../docs/judge-profiles.md).
All inputs, caches, labels, and per-checkpoint outputs must remain in ignored `eval/local/`.
The [September 2026 aggregate report](reports/2026-09-profile-search.md) records a negative result with no recommended profile change.

## Freeze the experiment

Build and label the dataset with [the dataset tools](dataset.md).
Keep each session and its linked copies in one split.
Use separate training, validation, and holdout groups.
Do not select a profile until the planned labelling and bounded adjudication are complete.
Retain disagreement and unpaired counts alongside the accepted labels.

Combine the frozen checkpoint bundles:

```sh
cd packages/pi-extension
python3 eval/tools/assemble.py eval/local/run/checkpoints.jsonl \
  eval/local/source-a/checkpoints.jsonl eval/local/source-b/checkpoints.jsonl
python3 eval/tools/optimise.py freeze eval/local/run/checkpoints.jsonl \
  eval/local/run/search-plan.json --protect claude-worker --protect pi-worker
```

Each `--protect` names a stratum exactly as it appears in the checkpoint set; the freeze requires at least one and rejects unknown names.
The plan records these names, and selection enforces the precision constraint only on them.
The published study protected `claude-worker` and `pi-worker`.

The assembler preserves explicit `contextUsage` values only with `usageSource` provenance.
Unknown usage stays unknown and uses the strictest floor.
Its optional `--comparison` imports historical Claude threshold inferences, never observed configuration.
Pi uses its model window, not a Claude auto-compaction threshold.
The final report includes strict and loose sensitivity results for unavailable usage.

The frozen search contains 390 profiles.
It varies the coordination weight over five values and floor endpoints over a fixed grid.
Floors never increase with usage.
Minimum context, cooldowns, recovery gates, question text, and auto consent stay unchanged.
No reflection calls are needed for this numeric search.

## Score development data

Create a private limits JSON file with these required fields:

- `expectedModel`: the exact returned judge model version that the comparison expects.
- `maxCalls`: the approved number of paid attempts, including retries.
- `maxInputTokens`: the ceiling for known input-token usage.
- `maxEstimatedUsd`: the approved estimate ceiling for this replay.
- `inputUsdPerMillion`: the explicit input-price assumption, not a claimed invoice.
- `failedCallEstimateUsd`: the explicit debit for a failed call with unavailable usage.

Before paid calls, record a cost estimate and provider quota evidence.
Unknown failure usage remains null, separate from known token totals.
The estimate guard reserves one failed-call debit before each new attempt.
Keep an additional allowance for any output tariff that the service does not expose.

```sh
node --import tsx eval/score-profile.ts eval/local/run/checkpoints.jsonl \
  eval/local/run/replay development eval/local/run/limits.json
```

The command above makes no paid calls.
For the default direct Jev route, supply `TYPESAFE_API_KEY` through the environment, then add `--execute` to score.
For alternative routes and their key, model, cache, and accounting requirements, see [Decisions replay](README.md#experimental-decisions-replay) and [Jev through OpenRouter](README.md#jev-replay-through-openrouter).
Never put the key in arguments, logs, or files.
Optional arguments after the limits file select a profile JSON file and a frozen selection file.
Use `-` for the shipped profile.

Run one scoring controller per ledger; replay is sequential.
The cache keys complete request bytes and the expected model version, plus any non-default TypeSafe endpoint.
Numeric profiles with unchanged questions share responses.
A cache hit does not make a model call.
Each new attempt saves its request, start marker, bounded response capture, result, and failure accounting.
A crash with an incomplete attempt stops replay for reconciliation.
A changed model version also stops replay.

A failed judgment receives one retry with identical request bytes by default.
The optional limits field `maxRetries` accepts only `0` or `1`; omission keeps `1`.
Set `"maxRetries": 0` when retries are not authorized. Each checkpoint then has only its
first attempt, and a saved first-attempt failure is reused without another request.
Existing retry results are not substituted in zero-retry mode; their attempts still
count in ledger usage. Use a fresh replay directory for a separately frozen experiment.
Exhausted attempts remain a saved no-hint outcome, and replay continues within its ceilings.
Response capture excludes headers and redacts known key values.
An oversized response retains a truncation marker rather than partial sensitive text.
Historical failures without response capture require an explicit accounting record before replay resumes.

## Select once, then unlock holdout

If initial labels disagree, `adjudication.py prepare DIRECTORY MANIFEST PLAN --seed SEED --max-pairs N` prepares a bounded, seeded second pass.
It requires completed initial attempts and reserves one retry call per provider by default.
The private plan uses the same budget and quota fields as `cohort.py`.
Run `cohort.py DIRECTORY DIRECTORY/adjudication/plan.json --execute` only after the initial controller exits.
The selected pairs receive identical prompts containing the worksheet and both anonymous prior labels.
Selection uses a seeded identity hash, not disagreement severity or desired truth classes.

Collation reads only the requested partition when given a manifest:

```sh
python3 eval/tools/collate.py eval/local/source-b \
  eval/local/source-b/development-agreement.json \
  --manifest eval/local/source-b/manifest.json --split development
python3 eval/tools/partition_labels.py eval/local/run/checkpoints.jsonl \
  eval/local/run/development-labels.jsonl development \
  eval/local/source-a/labels.jsonl eval/local/source-b/development-agreement.json
```

For a second pass, collate again with `--round-id adjudication` and the generated `adjudication/manifest.json`, using the same split filter.
`adjudication.py merge INITIAL ADJUDICATED OUTPUT` adds only renewed agreements; unresolved initial evidence remains available.
Use that merged output in `partition_labels.py`.

Collation records malformed attempts without inventing labels.
It rejects different prompt hashes between providers or between an initial attempt and its retry.
Each provider gets the same frozen prompt bytes.
Two malformed attempts leave that provider unresolved.

Run `optimise.py select CHECKPOINTS LABELS RESULTS PLAN OUTPUT` with the development-only files.
`RESULTS` is the `development-<profile-hash>.jsonl` file from replay.
The selector rejects holdout label or result identities in these inputs.
Training retains four candidates per weight.
The flat baseline searches every distinct successful validation score, plus zero and one, using the shipped coordination weight.
It is not restricted to the numeric candidate grid.
Validation selects the final candidate from the training shortlist, the shipped profile, and this flat baseline.
The objective is macro-average safe-completion recall at at least 95% union precision.
The union negative class is unfinished work or unsafe compaction.
The selected candidate must not increase unsafe false positives or reduce precision in any protected stratum against either baseline.
If no candidate meets the constraints, the selector retains the shipped profile.
If no flat baseline meets them, its fallback prioritises defined precision and records that limitation.

The selection records hashes of the checkpoint bytes, search plan, development labels, and results.
Do not overwrite the selection after inspecting holdout.
With the selection file supplied, `score-profile.ts` accepts the `holdout` partition.
`partition_labels.py ... holdout ... --selection SELECTION` then prepares the holdout labels.
Both commands refuse to unlock a different checkpoint bundle.

## Report results and uncertainty

Run `evaluate_profiles.py CHECKPOINTS HOLDOUT_LABELS HOLDOUT_RESULTS SELECTION OUTPUT`.
Its aggregate JSON compares shipped behavior, the validation-selected flat floor, and the selected profile.
It reports product, contract, and union metrics by stratum and sampling arm.
Unknown safety is separate from negative truth.
Missing-label sensitivity assigns unresolved and truth-unknown rows either binary truth to bound precision and recall.
These are worst/best-case possibilities, not confidence intervals.
Failed judgments count as no hint in end-to-end recall.
Rank metrics use successful judgments and handle score ties without depending on checkpoint order.

The paired bootstrap resamples whole session groups within each stratum.
Single-group strata have no independent within-stratum uncertainty estimate.
Report that limitation, especially for a holdout drawn from one supervision session.
Enriched-arm precision is not production precision.
Sparse checkpoints cannot reconstruct cooldowns or other stateful suppression faithfully.

Use `--legacy-output PRIVATE_DIRECTORY` to export inputs for `metrics.py`, `schedule.py`, and `earn.py`.
For the latter two, use the exported `decision` probabilities and the expression `p['positive']` in `earn.py`, or `p['decision']['positive']` in `schedule.py`.
The legacy bootstrap resamples checkpoints, not sessions, and its AP is sensitive to tie order.
Keep those diagnostics beside the session-cluster intervals, not as a replacement.
Do not publish their per-checkpoint identifiers.

Good hint timing does not establish that real compaction preserves necessary context.
A recommendation for auto mode needs separate continuation and recovery evidence.
