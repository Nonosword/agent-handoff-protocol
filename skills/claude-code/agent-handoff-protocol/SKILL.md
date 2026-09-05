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

An append-only worklog in a central store outside your project repo, one file per
project, keyed by the project's Git identity. Your repository is never modified.

## Which interface

If the `ahp_*` MCP tools are available this session (`ahp_pickup`, `ahp_start`,
`ahp_intent_open`, `ahp_intent_promote`, `ahp_end`, `ahp_read`, `ahp_verify`),
**use those** — the free-text fields (`actual`, `landmines`, `summary`, `plan`)
are passed as structured strings instead of through shell quoting.

Otherwise run the `ahp` CLI shown below. If `ahp` is not on PATH, tell the user
to run the project's `install.sh`.

Either way the steps and their order are the same. Below, each CLI command maps
to the same-named MCP tool (`ahp start …` → `ahp_start`, `ahp intent promote …`
→ `ahp_intent_promote`).

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

## What goes in the worklog — and what doesn't

The worklog is **session continuity**, not project memory. Before you write a
`landmine`, `next`, `finding` or `summary`, ask:

1. **Does this outlive the session?** A fact about *this* work-in-progress — a
   shortcut you took, the next step, a tree left dirty — belongs in the
   worklog. A fact that will still be true in a month — an architectural
   invariant, a "never do X here", a non-obvious constraint — belongs in the
   **project's own docs** (`README`, `CONTRIBUTING`, an `docs/` note, a
   checklist). Put it there and, if useful, point at it from `next`.
2. **Can an existing doc absorb it?** Prefer editing the doc that already
   covers the area over creating a new one.

The worklog does not re-surface your earlier `landmines` on pickup by design —
if it needs to survive, it is not a landmine, it is documentation.

## When stopping — DROP (best-effort; you may be cut off first)

```
ahp end --reason limit --summary "<what happened this session>" --gate pass --evidence "<proof>"
```

Use `--finding "<hazard>"` (repeatable) for anything the next agent must know;
it is required if `--gate` is not `pass`.

## Other

- `ahp dashboard` — every project at once: baton holder + plan, worklog state,
  open intents, `verify`, and drift (commits since the baton base with no
  promotion). The one command that runs **outside** a repo, so it answers "what
  is in flight anywhere". `-w` for a live view, `--json` for scripting. CLI only
  — there is no `ahp_dashboard` MCP tool, so shell out for it.
- `ahp status` — quick state check
- `ahp log` — readable history
- `ahp verify` — check the worklog is well-formed (strict by default: a quality
  warning fails it; `--lenient` / `ahp_verify {lenient:true}` for an old log).
  A "note:" line — e.g. a hard cutoff — is expected and never fails.
- `ahp --help` — full reference

## Worker identity

Records must be attributed, not left as `unknown`. Via the MCP tools this is
automatic (from the host handshake). Via the CLI, either export once —

```
export AHP_WORKER_ID=claude AHP_MODEL=claude AHP_RUNTIME=claude-code
```

— or pass `--worker-id claude --model claude --runtime claude-code` on your
`ahp start`. Later records in the session inherit it.
