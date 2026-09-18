# Measured results (diversified v3)

Aggregate metrics for the handed-to-user judge hillclimb. Session transcripts,
checkpoints, labels, results, and worksheets stay in gitignored `eval/local/`.
`QUALIFY_FLOOR` is unchanged at 0.90.

Measured on 136 labelled checkpoints (83 Pi, 53 Claude Code), three runs per
arm except where noted.

| metric | shipped | winner |
|---|---|---|
| contract precision | 65% | 74% |
| contract recall | 39% | 69% |
| task-boundary recall | 37% | 72% |
| tool-coding recall | 0 of 7 | 6 of 7 |
| product-truth recall | 38% | 59% |
| product-truth precision | 98% | 94% |

The 22 mid-task coding checkpoints keep zero false fires at every threshold
from 0.85 up. Product-truth precision moves 98% to 94% because those five rows
are gold `completed_checkpoint`; nine of the ten unsafe rows in the set are
phase complete.

## claude-supervision

v3 set, n=9 (6 rows gold `completed_checkpoint` + safe, 3 rows gold
`still_in_progress`). Shipped judge averaged over 2 runs, winner averaged over
3 runs.

| metric | shipped | winner |
|---|---|---|
| contract recall | 1/6 = 17% | 4/6 = 67% |
| contract precision | 100% | 100% |
| contract false fires | 0 of 3 | 0 of 3 |
| product-truth recall | 1/9 = 11% | 4/9 = 44% |
| product-truth FP | 0 | 0 |
| task-boundary recall | 0/1 | 1/1 |

Per-run contract true positives were [1, 1] shipped and [4, 4, 4] for the
winner, so this stratum has zero run-to-run variance. It confirms the winner
supports shipping at the unchanged 0.90 floor: recall roughly quadruples while
precision holds at 100% with no false fire on any of its three mid-task rows.
claude-supervision was the second-weakest stratum in the published baseline
gradient (17%, above only tool-coding at 0 of 7) and is now mid-pack. Alongside
it, tool-coding goes 0 of 7 to 6 of 7.
