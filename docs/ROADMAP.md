# ROADMAP — what gets built, in what order

> **ROADMAP.md** · v1.0 · 2026-11-13 ·
> This is the first roadmap for this repository. It holds two steps,
> recorded on the owner's rulings of 2026-11-13. It is not an inventory of
> open work; the issue tracker holds the rest. Changing the order is an
> amendment: say so in the pull request, don't drift.

## How to read this file

**Steps are ordered by gates, not by calendar.** Each step names the gate
that opens it. A step with an open gate is not late; it is waiting. This
file holds no dates for future work.

**Each step carries a promise class:**

- **BINDING** — ruled: it will be built, in this order.
- **PLANNED** — decided in principle; its detail waits on a spec, an open
  decision, or an outside dependency. Its place in the order can move by
  amendment.
- **EXPLORATORY** — named so nobody builds it by accident. No commitment
  to build it at all.

**Done mark.** When a step completes, one dated line goes under its
heading: `Done — merged YYYY-MM-DD, PR #N`. It is written in the pull
request that completes the step.

## Step 1 — Guidance in the job — PLANNED

A job can carry a block of standing guidance: a rule for this part of the
codebase, a decision already made, a trap that catches newcomers. The
dispatcher attaches it by a fixed step, and the worker is shown it word
for word, within a size cap. Issue
[#50](https://github.com/equationalapplications/axon-runtime/issues/50).

The worker stays contained. It needs no access to wherever the guidance
came from, and this runtime stays neutral about that source.

*Gate:* a spec. It settles whether guidance is a dedicated field of the
job contract or a documented context-file convention, where in the prompt
it sits, and what happens when it is over the cap.

*Why first:* it works with the harness as it is. It changes the security model
only by adding one bounded input: the spec confirms this before any code, and
when the step lands the README's bounded-input list (goal, context, inline
patch) gains an entry for the guidance cap. The spec also says how a
dispatcher-attached block relates to the operator-owned `extra_system_prompt`
rule.

## Step 2 — Guidance delivered while the job runs — PLANNED

Guidance arrives as the worker touches new files, not only at dispatch. A
job that wanders into another part of the codebase then gets the guidance
for that part.

*Gate:* step 1 merged. Then a spec that settles two things this runtime
does not have today: a way to load an extension into the harness, and a
read-only way out of the worker to the source of the guidance. Both touch
the security model in the README, so the spec must say what each one
changes there before any code is written.

*Why second:* step 1 covers the common case, where the dispatcher knows
the job's target files. This step is larger, and it loosens the
containment that step 1 keeps.

## What is intentionally absent

- **No dates.** The project runs on gates and reviews, not calendars.
- **No named source of guidance.** Any system may fill the block. This
  runtime does not depend on one.
