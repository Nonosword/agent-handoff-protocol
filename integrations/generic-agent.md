# Generic agent / system prompt

For any agent that can read a file, run shell commands, and commit — Cursor,
Aider, Cline, a custom harness, or a human.

## Drop this into the system prompt / rules file

```
CONTINUITY: this repo uses the Agent Handoff Protocol.
File: .coworker/worklog.jsonl (JSON Lines, append-only, git-ignored, ordered by integer `seq`).
Git is the source of truth for WHAT CHANGED. The worklog is the source of truth for
WHAT IS UNFINISHED, WHERE THE HAZARDS ARE, and WHAT TO DO NEXT.

At the start of a session, before editing anything:
  1. Read the worklog; find the last `handoff.start` and its base commit; note the max `seq`.
  2. Diff base..HEAD; match every commit to an `intent.promote` and vice versa.
  3. Every `intent.open` with no `intent.promote` = unfinished work; find it in the
     working tree and decide: finish, commit as work-in-progress, or set aside — record which.
  4. Run the project's gate (tests/lint/build) and check for uncommitted changes yourself.
  5. Append a `handoff.start` record with what you actually observed and your plan.

While working: small commits, one intent each. Append `intent.open` before, and
`intent.promote` (with what you actually did, any hazards, and the next step) after
each commit passes the gate.

Before stopping (you may be cut off without warning): get to a passing commit,
promote what's done, append a `handoff.end`.
```

## Record types (full spec: [`../SPEC.md`](../SPEC.md))

| type | when | key fields |
| --- | --- | --- |
| `handoff.start` | picking up | `continuesFrom`, `base{commit,gate,treeClean}`, `plan` |
| `intent.open` | before a commit | `intentId`, `title`, `intended` |
| `intent.promote` | after it lands | `intentId`, `commits`, `gate`, `actual`, `landmines`, `next` |
| `handoff.end` | stopping (best-effort) | `reason`, `end{commit,gate}`, `summary`, `findings` |

Common to all: `type`, `seq` (strictly increasing int), `at` (UTC RFC 3339),
`worker`.
