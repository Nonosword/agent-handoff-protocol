# Agent Handoff Protocol (AHP)

**Version:** 0.3.0 · **Status:** stable · **License:** MIT

The machine contract is [`schema/worklog.schema.json`](./schema/worklog.schema.json).
This document is normative; the JSON Schema, the reference `ahp` CLI and
[`tools/verify-worklog.mjs`](./tools/verify-worklog.mjs) are conformance aids, not
the authority. Where the procedures below name an `ahp` command, that is the
reference implementation of the step, not a requirement to use it.

## 1. Abstract

Autonomous coding agents run under usage limits and are rotated: when one agent's
budget is exhausted, another continues the work. An agent often cannot predict
when it will be cut off, so it cannot rely on performing a clean shutdown.

AHP makes every rotation — and every solo session — recoverable from durable
evidence alone. **What changed** is read from version control. **What is not done,
where the hazards are, and what to do next** is read from one append-only log: the
*worklog*.

The protocol applies whether or not a rotation is expected. A single agent working
alone follows the same procedure, because "alone" can become "relay" at any commit.

## 2. Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as
in RFC 2119.

- **Worker** — one agent identity within one continuous run (one model, one
  runtime, one session).
- **Session** — the span from a worker's *pickup* to its *drop* (or cutoff).
- **Baton** — the right to be the single active worker on a repository.
- **Pickup / drop** — acquiring / releasing the baton.
- **Worklog** — the append-only record stream defined in §4.
- **Intent** — a planned unit of work, normally one commit.
- **Promote** — record that an intent's commit has landed, with its actual result.
- **VCS** — the version-control system. This document uses Git; §10 covers others.
- **Gate** — the project's own verification command (tests, lint, type-check,
  build — whatever the project already treats as "is it OK to commit").

## 3. The problem

Rotated agents lose continuity in three ways this protocol addresses:

1. **Silent cutoff.** A worker hits its limit mid-edit. The next worker sees an
   uncommitted diff with no explanation.
2. **Lost intent.** Commits show *what* changed but not *why this and not that*,
   what was deliberately deferred, or what the worker would have done next.
3. **Trusted-but-wrong summaries.** A free-text "here's what I did" is unverifiable
   and tends to over-claim (marking things done that have a failing test).

## 4. Model

### 4.1 Division of authority

| Question | Authority |
| --- | --- |
| What files changed, and in which commits? | VCS history |
| What was the intent of each change? | worklog `intent.*` |
| What is unfinished or uncommitted right now? | worklog: `intent.open` with no `intent.promote` |
| Where are the hazards / shortcuts / flaky bits? | worklog `landmines` |
| What should the next worker do? | worklog `next` / `plan` |
| Was the tree healthy at the handoff boundary? | worker re-verifies; worklog records what was observed |

A worklog MUST NOT restate what `git log` already carries. Its job is the column
VCS cannot express.

### 4.2 The worklog

A single [JSON Lines](https://jsonlines.org/) stream per project. Its properties,
regardless of where it is stored:

- **Format.** One JSON object per line, UTF-8, LF-terminated. No comments, no
  trailing commas.
- **Not VCS-tracked.** It is process state, not product, and MUST NOT be
  committed to the project repository.
- **Append-only.** Existing lines MUST NOT be edited, reordered or deleted.
  Corrections are new records.
- **Single active writer.** At most one worker holds the baton, so appends are
  race-free. A worker that detects a second active writer (see §8) MUST stop.
- **Ordered by `seq`.** A strictly increasing integer, starting at 1. Ordering
  MUST derive from `seq`, never from `at`, because clocks differ across machines
  and runtimes.

### 4.3 Storage bindings

The records and procedures are identical under either binding:

- **In-repo.** `.coworker/worklog.jsonl` at the repository root, with
  `.coworker/` in the project's ignore file. Simple; co-located with the code.
- **External store.** A per-user store outside every project, one file per
  project, keyed by the project's identity (§4.4). The project repository is not
  touched at all. This is what the reference `ahp` implementation uses by
  default, at `$XDG_DATA_HOME/agent-handoff/` (falling back to
  `~/.local/share/agent-handoff/`).

A worker does not need to know which binding is in effect; it asks the
implementation for "this project's worklog".

### 4.4 Project identity

For the external-store binding, a project's key MUST be stable across working
directories and, where possible, across re-clones. Derive it from VCS:

- if an `origin` remote is configured — a slug of the **normalized remote URL**
  (`git@github.com:User/Repo.git` and `https://github.com/User/Repo` both reduce
  to `github.com/user/repo`);
- otherwise — the repository's top-level path plus a short hash of it.

The implementation SHOULD keep a registry recording each project's name, remote
and every local path it has been seen at, so a moved checkout still resolves.

## 5. Records

Every record is a JSON object with these common fields:

| Field | Type | Rule |
| --- | --- | --- |
| `type` | string | one of `handoff.start`, `handoff.end`, `intent.open`, `intent.promote` |
| `seq` | integer | strictly greater than the previous record's `seq` |
| `at` | string | RFC 3339 timestamp in UTC, e.g. `2026-08-28T14:03:00Z` |
| `worker` | string \| object | worker identity (see §5.1) |

Implementations MAY add fields not defined here; consumers MUST ignore unknown
fields.

### 5.1 Worker identity

`worker` is either a short string id, or an object:

```json
{ "id": "claude-03", "model": "claude", "runtime": "claude-code" }
```

`intent.*` records MAY carry the short id form; a `handoff.start` SHOULD carry the
object form at least once per session so the log is self-describing.

### 5.2 `handoff.start`

Written by a worker when it picks up the baton, after completing §7.1.

| Field | Type | Rule |
| --- | --- | --- |
| `continuesFrom` | integer \| null | `seq` of the previous `handoff.start`, or `null` for the first ever |
| `base` | object | the verified starting state (below) |
| `plan` | string | what this worker intends to attempt this session |

`base`:

| Field | Type | Rule |
| --- | --- | --- |
| `commit` | string | VCS revision the worker starts from (HEAD at pickup) |
| `gate` | string | `pass`, `fail` or `not-run` — what the worker **observed by running it**, not what a prior record claimed |
| `gateEvidence` | string | short proof, e.g. `"312 tests pass"` — SHOULD be present when `gate` is `pass` |
| `treeClean` | boolean | whether the working tree had uncommitted changes at pickup |
| `verifiedBy` | string | `self` — the worker MUST have verified this itself |

### 5.3 `handoff.end`

Best-effort, written by a worker when it stops. A consumer MUST NOT depend on this
record existing; §7.1 recovers the same state without it.

| Field | Type | Rule |
| --- | --- | --- |
| `reason` | string | `limit`, `task-done`, `blocked`, or `handoff-requested` |
| `end` | object | same shape as `base` in §5.2 (`commit`, `gate`, `gateEvidence`, `treeClean`) |
| `summary` | string | what actually happened this session |
| `openIntents` | string[] | `intentId`s left un-promoted |
| `findings` | string[] | hazards for the next worker; REQUIRED and non-empty if `end.gate` is not `pass` |

### 5.4 `intent.open`

Written before starting a unit of work.

| Field | Type | Rule |
| --- | --- | --- |
| `intentId` | string | unique within the worklog; SHOULD be short and dated, e.g. `i-0828-a` |
| `title` | string | one line |
| `intended` | string | what the worker plans to do and why |
| `refs` | string[] | optional — issue ids, checklist items, ticket URLs this advances |
| `scope` | string[] | optional — expected file globs / paths |

### 5.5 `intent.promote`

Written after the intent's commit has landed.

| Field | Type | Rule |
| --- | --- | --- |
| `intentId` | string | MUST match a prior `intent.open`; MUST NOT be promoted twice |
| `commits` | string[] | VCS revisions that realized this intent; MUST be non-empty unless `gate` is `fail` |
| `gate` | string | `pass`, `fail` or `not-run` for the resulting commit(s) |
| `actual` | string | what was actually done, including deviations from `intended` |
| `landmines` | string[] | hazards, shortcuts, deferred work, optimistic status marks; REQUIRED and non-empty if `gate` is `fail` |
| `next` | string | optional — the immediate follow-up |

A `gate: "fail"` promotion is permitted **only** when the matching commit is an
explicit work-in-progress commit (e.g. a `wip:` subject). `landmines` MUST then
state precisely what is broken.

## 6. Intent lifecycle

```
intent.open ──────────────► (work) ──────────────► intent.promote
   "what I intend"                                   "what I did · landmines · next"

open, no promote  =  unfinished or uncommitted work
                     → the pointer the next worker follows into the dirty tree
```

## 7. Procedures

### 7.1 Pickup — every worker, every session

A worker MUST, before making any change:

1. Read the worklog. Find the last `handoff.start` and its `base.commit`; note the
   highest `seq`.  *(`ahp pickup` does steps 1–4.)*
2. List the VCS history from `base.commit` to HEAD.
3. Reconcile: every commit since `base.commit` SHOULD correspond to an
   `intent.promote`; every `intent.promote` SHOULD name a commit reachable from
   HEAD. Investigate any mismatch before new work.
4. For every `intent.open` with no `intent.promote`: inspect the working tree for
   matching uncommitted work. Decide, per intent — finish it, commit it as
   work-in-progress with a promotion, or set it aside and record the disposition.
5. **Verify the baton independently.** Confirm the working tree state and run the
   gate. Record what was observed, not what a prior record claimed.
6. Append a `handoff.start` with the verified `base` and a `plan`.
   *(`ahp start --plan … --gate …` — `base.commit`, tree state and `seq` are
   filled in from Git and the log.)*

### 7.2 Working

7. Split the task into small, single-intent commits. Append `intent.open` before
   each. *(`ahp intent open --id … --title … --intended …`)*
8. After each commit passes the gate, append `intent.promote` with `commits`,
   `actual`, `landmines`, `next`.
   *(`ahp intent promote --id … --commit … --gate … --actual …`)*
9. Do not cross a commit boundary leaving a dirty tree that no open intent
   describes.

### 7.3 Drop — best-effort

10. Move to the nearest gate-passing commit. Promote every completed intent.
    Append `handoff.end`. If cut off before this, §7.1 still recovers the state.
    *(`ahp end --reason … --summary … --gate …`)*

## 8. Recovery

| Situation | Required handling |
| --- | --- |
| Worklog file absent | Treat as a fresh start. First worker creates it with `continuesFrom: null`. |
| Worklog not valid JSONL | Stop. Do not append. Surface the corrupt line to the operator. |
| `seq` not strictly increasing | Stop. The log was edited or written concurrently. Operator disposition required. |
| Two `handoff.start` with no `handoff.end` between | Normal after a cutoff. The later one is authoritative; the earlier worker's work is reconstructed via §7.1 steps 2–4. |
| `handoff.start` present again with the *same* `worker.id` while you believe you hold the baton | A second active writer. Stop immediately. |
| `intent.promote` names a commit not reachable from HEAD | History was rewritten or the commit never pushed. Investigate before trusting the promotion. |
| Worklog claims `gate: pass` but the gate fails now | The worklog is advisory; §7.1 step 5 is why the worker re-verifies. Fix to green before new work; record a finding. |

## 9. Retention

The worklog grows without bound. To compact (`ahp compact --keep N`):

- Move a contiguous span of the oldest lines to
  `.coworker/worklog.archive/<firstSeq>-<lastSeq>.jsonl` (also not VCS-tracked).
- The live file MUST retain enough context for §7.1: at minimum the last
  completed session, plus every `intent.open` that is still un-promoted. `seq`
  continues from where the live file now starts.
- Never rewrite or renumber records. Compaction only moves whole lines.

## 10. VCS binding

Git is the reference. For another VCS, substitute:

- "list history from X to HEAD" → the equivalent revision-range log
- "reachable from HEAD" → the equivalent ancestry query

The record fields (`commit`, `commits`, `base.commit`) hold whatever revision
identifier the VCS uses.

## 11. Security and privacy

- The worklog MUST NOT contain secrets, tokens, credentials, or customer data.
  Free-text fields (`actual`, `findings`, `landmines`, `summary`) are the risk.
- Paths in the worklog SHOULD be repository-relative, never absolute machine
  paths.
- The file is local and ignored by VCS, but may still be captured by editor sync,
  backups or crash reporters. Treat it as "internal, not encrypted".

## 12. Conformance

- A **conformant producer** appends only well-formed records (§5), in `seq` order,
  and performs §7.1 before its first change.
- A **conformant consumer** performs §7.1 and tolerates a missing `handoff.end`.
- A **conformant validator** enforces §5 structure and the §6 lifecycle
  (`promote` requires a prior `open`; no double promote; `fail` requires
  `landmines`) and reports un-promoted intents. It is not required to consult the
  VCS.

The `ahp` CLI in this repository is the reference producer and consumer;
`ahp verify` and `tools/verify-worklog.mjs` are reference validators.

## 13. Non-goals

AHP is **not** a task tracker, an issue system, a CI gate, a replacement for
clear commit messages, or a multi-writer coordination protocol. It is the thin
continuity layer between those things and a rotated set of agents.

## 14. Prior art

The pattern generalizes practices that predate it: engineering daybooks, the
"handoff note" in on-call rotations, `NEXT.md` / `TODO.md` scratch files, and the
discipline of committing small and often. AHP's contribution is making the
handoff note *structured*, *append-only*, and *anchored to VCS* so a fresh agent
can trust it without a human in the loop.

## Appendix A. Minimal example

```jsonl
{"type":"handoff.start","seq":1,"at":"2026-08-28T09:00:00Z","worker":{"id":"a1","model":"codex","runtime":"codex-cli"},"continuesFrom":null,"base":{"commit":"3f2a1c0","gate":"pass","gateEvidence":"188 tests pass","treeClean":true,"verifiedBy":"self"},"plan":"add request rate limiting to the public API in ~3 commits"}
{"type":"intent.open","seq":2,"at":"2026-08-28T09:10:00Z","worker":"a1","intentId":"i-0828-a","title":"token-bucket limiter middleware","intended":"per-IP token bucket, configurable rate, 429 on exhaustion","scope":["src/middleware/rate-limit.*"]}
{"type":"intent.promote","seq":3,"at":"2026-08-28T09:38:00Z","worker":"a1","intentId":"i-0828-a","commits":["b4d5e6f"],"gate":"pass","actual":"token-bucket middleware + 6 tests; rate is env-configurable","landmines":["bucket state is in-process only — will not hold across replicas; noted for the next step"],"next":"move bucket state behind the shared cache"}
{"type":"handoff.end","seq":4,"at":"2026-08-28T13:30:00Z","worker":"a1","reason":"limit","end":{"commit":"b4d5e6f","gate":"pass","gateEvidence":"194 tests pass","treeClean":true},"summary":"1 of 3 commits landed; limiter works single-process","openIntents":[],"findings":["next step is the shared-cache bucket; see i-0828-a landmine"]}
```
