# Rationale & FAQ

## When I resume after another agent worked, do I see everything, or just what changed?

You see **what changed since the last handoff** — not a full history dump, and
not "just since my own last commit."

`ahp pickup` anchors to the *last* `handoff.start` and its base commit, whoever
wrote it. So if Codex ran, then Claude ran and committed six times, then Codex's
limit resets and Codex resumes: Codex's pickup shows Claude's six commits, their
`landmines`, and their open intents — bounded to that one session. Codex does
**not** rewind to its own earlier commit.

This is deliberate:

- **A resumed agent's memory is a liability.** It still holds its pre-reset plan
  and its old view of the tree, but the tree has moved. Forcing a clean pickup
  makes it reconcile with ground truth instead of "continuing my thing."
- **The `next` fields chain forward.** The previous worker's last
  `intent.promote.next` / `handoff.end.findings` is the instruction. You don't
  need your own old plan — the other agent may have already done it, or changed
  direction.
- **The view is bounded.** You get one session's worth of context, not 40
  records. `ahp log` shows the rest if you want it.

`ahp pickup` prints a line — *"You (codex) last held the baton at seq 14, N
handoffs since; your earlier plan may be stale"* — when it recognises a prior
turn of yours, so the resumed agent is told plainly: don't dwell, reconcile,
continue forward.

What you *lose*: your own earlier `landmines` aren't re-surfaced on pickup. That
is correct — the worklog is session continuity, not permanent project memory. A
constraint that outlives a session (an architectural invariant, a "never do X")
belongs in the project's own docs / checklist. `ahp log --worker <id>` still
shows any one agent's complete trail for audit or analysis.

## Why a store outside the repo instead of a file in it?

So the protocol can run against a repository that must stay pristine — no new
directory, no `.gitignore` line, no risk of the worklog ending up in a diff or a
PR. It also lets one agent host serve many projects at once, each isolated. The
in-repo layout (`.coworker/worklog.jsonl`) still works if you prefer co-location;
the records and procedures are identical either way (SPEC §4.3).

## JSON Lines, not SQLite — why?

The core invariant is *one active writer* (one baton), so SQLite's headline
feature — concurrent-write safety — solves a problem the protocol designs away.
Worklogs are small (retention keeps only recent sessions live), so "list the open
intents" is an instant scan. And a plain-text, greppable, `tail`-able file is a
feature for a handoff/debug tool: when a rotation goes wrong you read the file,
not a database. A bad JSONL line is fixable; a corrupt SQLite page may not be.
The CLI gives you the *ergonomics* of a database (`ahp status`, `ahp log`)
without the database.

## Why a CLI and not just "write these JSON lines"?

Because the tedious parts — assigning `seq`, formatting the timestamp, reading
`git rev-parse HEAD` and `git status`, checking the intent lifecycle — are
exactly where hand-written records go wrong. The agent supplies meaning
(`--plan`, `--actual`, `--landmine`); `ahp` supplies the bookkeeping and refuses
malformed sequences.

## Why not just read the commit messages?

Commit messages are the authority for *what changed* — AHP leans on them and does
not duplicate them. They are a poor fit for three things:

- **Work that isn't committed yet.** A worker cut off mid-edit has no commit. The
  `intent.open` with no `intent.promote` is the only durable pointer to that
  diff.
- **Deliberate non-choices.** "I used an in-process bucket and *did not* wire the
  shared cache, because X" — that belongs in `landmines` / `next`, not squeezed
  into a commit subject.
- **Honest status.** A commit can say "add feature" while a test fails. The
  `gate` field on a promotion, cross-checked by the next worker actually running
  the gate, keeps the record truthful.

## Why append-only? Why not a doc I can edit?

An editable `HANDOFF.md` has no history and no blame. If a handoff is wrong you
can't see how it got that way, and two workers editing it across a rotation will
clobber each other. Append-only + `seq` gives you an ordered, tamper-evident
trail with a single writer at a time.

## Why `seq` instead of timestamps?

Three runtimes on two machines will not agree on the clock, and two records in
the same second are common. `seq` is a monotonic integer: read the last line,
add one. Timestamps stay in the record for humans, but ordering never depends on
them.

## Why is the worklog not committed?

It is process state, not product. Committing it would:

- put it in every diff and PR, adding noise
- invite merge conflicts on a file that is meant to have one writer
- tempt people to treat it as a deliverable and polish it

The principle: operator/process state is not editable source, and doesn't belong
in the tree that ships. Archive a span outside the repo if you need to keep it.

## What if the worklog and Git disagree?

Git wins on *what changed*. If a promotion claims a commit that isn't in history,
the promotion is suspect — investigate before trusting anything else in that
session's records. If the log claims `gate: pass` and the gate fails now, the log
was optimistic; that's exactly why the pickup sequence has the worker re-run the
gate rather than trust the record.

## Isn't this a lot of overhead per commit?

Two short JSON lines per commit — `intent.open` before, `intent.promote` after.
In practice an agent writes them in the same breath as the commit message. The
payoff is that a fresh agent (or you, a week later) can resume in one read
instead of reverse-engineering a dirty tree.

## Can a human use this?

Yes. On-call handoffs, "picking up someone's branch", coming back to your own
work after two weeks — the same file works. The protocol is written for agents
because agents are the case where *nobody* is in the loop to explain the mess.

## Does it need Git?

The procedures are written against Git. Any VCS with a revision-range log and an
ancestry query works — substitute the equivalent commands (SPEC §10). The record
fields just hold whatever revision identifier your VCS uses.

## How do I stop the worklog growing forever?

`ahp compact --keep N` (SPEC §9): moves all but the last N sessions to an
`archive/` folder beside the live file, keeping every still-open intent. Records
are only *moved*, never rewritten.

## Where does this come from?

Extracted from a real project that rotates several coding agents under usage
limits. The specifics of that project are not in here; what's left is the part
that generalizes.
