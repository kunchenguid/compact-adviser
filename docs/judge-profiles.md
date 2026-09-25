# Judge profiles

A profile is a JSON object that changes judge questions or decision thresholds.
Use a profile to evaluate a session-specific policy without changing the shipped defaults.
The runtime judge remains TypeSafe Jev on every host.
An empty or absent `profile` setting uses the shipped policy.

Keep `mode` set to `hint` while evaluating a profile.
A profile changes the shared hint and auto gate, but it does not grant auto consent.
Evidence that a hint occurs at a good moment does not prove that compaction preserves needed context.
This feature does not change minimum token counts, cooldowns, or recovery gates.

## Format

This example reproduces the shipped score and floor schedule:

```json
{
  "version": 1,
  "coordinationWeight": 0.5,
  "floors": [[0.1, 0.9], [0.9, 0.5]]
}
```

The score is `P(finished) * (1 - coordinationWeight + coordinationWeight * P(hands_on))`.
The weight must be between zero and one.
A weight of zero removes the coordination penalty.
This is an available setting, not a recommendation.

Each floor point contains `[usageFraction, requiredScore]`.
The gate interpolates between points and rounds the result to three decimal places.
Usage below the first point uses the first floor.
Usage above the last point uses the last floor.
Unknown usage uses the first, strictest floor.
A single point sets a constant floor.

A profile accepts one to eight points.
Usage values must strictly increase, and floors must not increase.
Every value must be between zero and one.
The same host-specific usage denominator applies with and without a profile, and a context budget, when set, replaces it in both cases whenever the budget is the smaller of the two.

The optional `questions` field replaces both questions in full.
It has the same structure as `QUESTIONS` in `packages/pi-extension/src/judge.ts`.
Only the instruction and criterion text can change.
Keep `type: "choice"`, both question keys, and all criterion keys:

- `done`: `finished`, `not_finished`, `unclear`.
- `shape`: `hands_on`, `coordinating`, `unclear`.

The serialized profile must fit within 4,096 UTF-8 bytes.
Unknown fields, empty text, invalid values, and malformed JSON disable advice.
Clear the setting or restore valid JSON to enable advice again.
Profiles cannot execute code, load files, or select another provider.

## Load a profile

The `profile` setting holds a JSON **string**, not an embedded object.
For the example above, the configuration field is:

```json
"profile": "{\"version\":1,\"coordinationWeight\":0.5,\"floors\":[[0.1,0.9],[0.9,0.5]]}"
```

Use the same string on each host:

- Pi: add `profile` to `compact-adviser.json` in the Pi agent directory, normally `~/.pi/agent`.
- Claude Code: set `compact-adviser.profile` in `/config` to the serialized JSON text, without the outer string quotes.
- Codex: add `profile` to `${CODEX_HOME:-~/.codex}/compact-adviser/settings.json`.
- Grok: add `profile` to `${GROK_HOME:-~/.grok}/compact-adviser/settings.json`.

Preserve existing fields, especially saved keys and mode consent.
If the configuration file does not exist, first use the host's adviser controls to create it.
Do not replace the whole file with the profile object.
To restore shipped behavior, set the string to `""` or remove the field.

Request logs contain the selected questions.
Response logs contain the score, floor, and decision from the selected profile.
A change to the profile during a pending judgment prevents that judgment from producing advice.

## Default equivalence

All four packages keep the same built-in questions, score, and floor schedule.
The profile parser and judge behavior are tested across hosts in
`packages/pi-extension/test/profile.test.ts`.
Each host also tests its hook or extension with a stored profile.
Default-equivalence tests compare emitted requests and decisions across usage boundaries.
No tailored profile is recommended by this feature alone.
