# Rationale & FAQ

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

SPEC §9: move the oldest contiguous span of lines to
`.coworker/worklog.archive/<range>.jsonl` (also un-tracked). Keep at least the
last completed session plus every still-open intent in the live file. Never
rewrite lines — compaction only *moves* them.

## Where does this come from?

Extracted from a real project that rotates several coding agents under usage
limits. The specifics of that project are not in here; what's left is the part
that generalizes.
