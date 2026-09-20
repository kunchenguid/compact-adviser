# Vision

`compact-adviser` exists so that a person running a coding agent learns when compacting is safe, instead of watching a context meter and guessing.
It serves the human at the terminal, and it turns a settled turn of their own session into one piece of timely advice: compact now, or nothing at all.
It owns exactly one thing: the timing of `/compact`.

## The question is the whole product

The product answers "should I /compact now?" and nothing adjacent.
It never writes the summary, never chooses what to keep, and never replaces the host's own compaction path, which stays authoritative and stays lossy.
It does not manage context, prune transcripts, rewrite history, or hold opinions about how an agent should work.
A feature earns its place only by making that one answer arrive more often when it is right, or less often when it is wrong.

## Advice is for the person, never for the model

The hint is rendered to the human and is never written into the conversation, returned as hook feedback, or used to steer the agent.
A host that cannot separate those two channels does not get a hint at all.
One judgment produces one hint on one surface; duplicate notifications, idle status strips, and standing badges are removed rather than tuned.
The hint says what to do, not how it was decided: the questions, the scores, and the thresholds stay internal so they remain free to change, and so the user is never handed a number to interpret.
Advice arrives only at a settled turn, never in front of an action the person is trying to take.
The product spends the user's attention to tell them to act, and not otherwise; it puts no meter, gauge, or counter in front of anyone.
State it already holds is fair to report when the person explicitly asks for it, because a command someone typed is not attention the product took.
When it has nothing to say, the session looks exactly as it would without it installed.

## Measurement decides, and the measurement is published

Judge questions, score weights, and floors are implementation, not doctrine.
They change whenever a measurement on replayed real checkpoints shows a gain, and a question deleted for carrying no information is welcome back the day it earns its place.
Every such change ships with its numbers stated, including recall, precision, and the caveats that do not flatter it.
The eval harness drives production `snapshot()`, `judge()`, and the shipped gate rather than a reimplementation, so a result is about the product and not about the test.
When the adviser is silent, the first move is to find out why it cannot answer, not to lower the bar until it speaks.
The harness and the label rubric ship; the dataset stays local, because it is made of real sessions.
It would ship in redacted form only if the redacted set still reproduces the published scores, since a corpus that cannot reproduce them proves nothing.

## The cost of being wrong changes as the window fills

A wrong hint costs most when the window is still mostly empty, and least when the host is about to compact anyway.
Near the top the larger cost is the hint that never comes, so the bar starts strict and relaxes as the context fills: precision where there is room, recall where there is not.
The absolute minimum before any judgment stays absolute, because the tokens a compaction saves are the same money on a small window and a large one.
Errors, timeouts, malformed responses, unreadable usage, and invalid configuration resolve to no advice, never to an affirmative one.
Cheap local state is inspected before any network request.
Where there is no human to read a hint, in a non-interactive or unattended session reliably detected from the host rather than guessed from ambient environment variables, the product does nothing and says nothing.
A session nobody is watching is served by automatic mode if its owner chose it, never by routing advice to some other person.
Every install has a single kill switch that beats every other enablement path.

## Accuracy is the entry price, for every judge and every feature

The judge is a dependency, not an identity: no provider is part of what this product is, and the shipped default is simply the most accurate judge measured.
The product never silently substitutes a cheaper one.
A person may explicitly choose a different judge, including a local one, and may accept somewhat less accuracy for what it buys them, provided that judge has been rigorously evaluated and is good enough for regular use.
What is refused is an unevaluated heuristic that guesses at completion, because guessing is what the product exists to end.
The same rule governs features: one that cannot be built accurately is left absent and documented, not approximated by the most likely answer.
One default ships and setup asks nothing; a person who wants a different policy goes and sets it, rather than being interviewed before the product will work.

## One policy, several hosts, no shared runtime

Each supported host gets its own implementation that owns its events, storage, and installation, and no implementation reads or loads another's.
What is shared is the policy, not the machinery: the judge questions, the score, and the floor schedule are byte-identical across hosts, and a test fails when one copy drifts.
A host adapter is built against what that host actually does, verified by a live end-to-end suite on a pinned version, and its limits are stated in the product rather than papered over.
When a host gives no outside process a way to run `/compact`, it ships hint-only and says so; an `auto` that cannot be honoured is never offered.
A host whose install needs manual steps is kept and its tax is documented when the host leaves no way around it; the cost of supporting an awkward host is not a reason to drop it.
A host that cannot support the full policy may run a reduction of it, so long as the questions and the score stay identical and the reduction follows an existing rule rather than inventing a new one.
Adding a host is welcome when it is the same product on new ground; it is refused when it would require the shared policy to fork.

## What leaves the machine, and on whose word

Installing the package is the consent to send eligible checkpoint context to the judge; there is no second toggle pretending to be a choice.
Nothing else leaves: no usage reporting, no outcome pings, no telemetry, opt-in or otherwise.
Automatic compaction is a separate, explicit, first-use acknowledgement inside the session, and nothing else can grant it.
Judge policy is a personal setting belonging to the person at the keyboard; no repository, team, or shared configuration chooses it for them.
What is sent is bounded and documented alongside what is not, redaction is described as best-effort rather than as a guarantee, and the API key never enters the model context, a request body, a log, or a status line.
A person who cannot accept that boundary is told plainly to uninstall rather than sold a setting.

## Scope

This is not a context manager, not a summarizer, not an agent framework, and not a telemetry product.
It is not a host: it never installs, patches, or updates the user's Pi, Claude Code, Codex, or Grok.
Real session transcripts, gold labels, and eval output stay local and are never committed or published.
The repository holds itself to the same bar it asks of the advice: generated files are generated, host versions are pinned, and contributor pull requests come through the review gate.
These commitments describe what this project ships, and are not defended by runtime machinery that a fork could delete as easily as the commitment itself.

A change aligns when it makes the one answer more accurate, more timely, or quieter; when it is backed by a measurement on real checkpoints with its downsides stated; when it keeps the questions and the score identical across hosts; and when it costs the user no attention it does not repay.
A change should be resisted when it grows the product past the timing question, when it puts the hint in front of the model or in front of the user's next action, when it trades accuracy for reach, when it sends anything the one judgment does not require, or when it lets someone other than the person at the keyboard decide how their session is judged.
