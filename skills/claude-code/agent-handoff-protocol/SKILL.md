---
name: agent-handoff-protocol
description: >-
  Session continuity for rotated coding agents. Use at the START of every coding
  session (before the first change) to pick up where the previous agent — or you,
  earlier — left off, and while working to record intent and hazards so the next
  agent can continue after a usage-limit cutoff. Trigger words: handoff, pick up,
  resume work, continue where I left off, worklog, baton, "what was I doing".
---

# Agent Handoff Protocol

The `ahp` CLI stores an append-only worklog in a central store (outside your
project repo), one file per project, keyed by the project's Git identity. Your
repository is never modified.

If `ahp` is not on PATH, it is at `~/.local/share/agent-handoff/` install docs —
tell the user to run the project's `install.sh`.

## At the start of a session — PICKUP (do this before any change)

```
ahp pickup
```

Read its output. It shows the last handoff, every commit since that handoff's
base, which commits are accounted for by an `intent.promote`, and any **open
intents** (declared work with no promotion — i.e. probably uncommitted).

Then, per open intent, look at the working tree (`git status`, `git diff`) and
decide: finish it, commit it as `wip:` and promote it, or stash it. Run the
project's own gate (tests / lint / build) yourself — don't trust the recorded
result. Then take the baton:

```
ahp start --plan "<what you intend to do>" --gate pass --evidence "<proof, e.g. 200 tests pass>"
```

(Set `--gate fail` or `--gate not-run` honestly if that's the case.)

## While working — one intent per commit

Before starting a unit of work:

```
ahp intent open --id i-<date>-<letter> --title "<short>" --intended "<what and why>" --scope "<glob>"
```

After its commit lands and the gate passes:

```
ahp intent promote --id i-<date>-<letter> --commit <sha> --gate pass \
  --actual "<what you actually did>" --landmine "<a hazard>" --next "<the follow-up>"
```

Never leave the tree dirty across a commit boundary without an open intent that
describes it.

## When stopping — DROP (best-effort; you may be cut off first)

```
ahp end --reason limit --summary "<what happened this session>" --gate pass --evidence "<proof>"
```

Use `--finding "<hazard>"` (repeatable) for anything the next agent must know;
it is required if `--gate` is not `pass`.

## Other

- `ahp status` — quick state check
- `ahp log` — readable history
- `ahp verify` — check the worklog is well-formed
- `ahp --help` — full reference

The worker identity is read from `$AHP_WORKER_ID` / `$AHP_MODEL` / `$AHP_RUNTIME`
if set, otherwise inherited from the last `handoff.start`. Pass
`--worker-id claude --model claude --runtime claude-code` on `ahp start` to set it.
