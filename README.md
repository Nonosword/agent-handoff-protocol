# Agent Handoff Protocol (AHP)

**English** · [简体中文](./README.zh-CN.md)

[![ci](https://github.com/Nonosword/agent-handoff-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/Nonosword/agent-handoff-protocol/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![spec: 0.1.0](https://img.shields.io/badge/spec-0.1.0%20draft-orange.svg)](./SPEC.md)

> A tiny append-only log so rotated coding agents don't lose the thread when one
> hits its usage limit and the next takes over.

## The problem

You run several coding agents against one repo — Codex, Claude, a local model —
and rotate them as each hits its usage limit. An agent often gets cut off
**mid-edit**, with no chance to explain itself. The next agent inherits:

- an uncommitted diff with no context,
- commits that show *what* changed but not what was deliberately skipped or what
  came next,
- and, if it trusts a hand-written "here's what I did" summary, a decent chance
  that summary is wrong (marks work done that has a failing test).

## The idea

Split the record in two, by what each medium is good at:

| Question | Answered by |
| --- | --- |
| What files changed, in which commits? | **Git history** |
| What was each change *for*? | worklog — `intent.*` |
| What's unfinished or uncommitted *right now*? | worklog — an `intent.open` with no `intent.promote` |
| Where are the hazards and shortcuts? | worklog — `landmines` |
| What should the next agent do? | worklog — `next` / `plan` |

The worklog is `.coworker/worklog.jsonl`: repository root, **git-ignored**,
**append-only**, one JSON object per line, ordered by an integer `seq`.

```
.coworker/worklog.jsonl

  handoff.start   ── agent picks up: verified base commit + gate result + plan
    intent.open      ── before a small commit: what I intend
    intent.promote   ── after it lands green: what I did · landmines · next
    intent.open
    intent.promote
  handoff.end     ── best-effort on stop: end commit + gate + findings + open intents

  handoff.start   ── next agent: reconcile commits since the last base,
                     adopt any open intent, re-verify, continue
```

An `intent.open` with no matching `intent.promote` is the pointer the next agent
follows straight to the unfinished work in the dirty tree — even if the previous
agent vanished without writing `handoff.end`.

## Quick start

**1.** Ignore the worklog — add to your project's `.gitignore`:

```
.coworker/
```

**2.** Tell your agents to follow the protocol. Copy the snippet for your setup
from [`integrations/`](./integrations/) — [Claude Code](./integrations/claude-code.md),
[Codex](./integrations/codex.md), [generic](./integrations/generic-agent.md) — into
`CLAUDE.md` / `AGENTS.md` / your system prompt.

**3.** Vendor the validator (zero dependencies) and run it at pickup and before
stopping:

```sh
node tools/verify-worklog.mjs
```

The first agent creates the file with a single `handoff.start`
(`continuesFrom: null`). That's it.

## Records

Four types. Full field tables in [`SPEC.md`](./SPEC.md) §5; machine contract in
[`schema/worklog.schema.json`](./schema/worklog.schema.json).

| type | when | carries |
| --- | --- | --- |
| `handoff.start` | picking up the baton | `base` (verified commit + gate + tree state), `plan`, `continuesFrom` |
| `intent.open` | before a commit | `intentId`, `title`, `intended` |
| `intent.promote` | after it lands green | `commits`, `gate`, `actual`, `landmines`, `next` |
| `handoff.end` | stopping (best-effort) | `reason`, `end` (commit + gate), `summary`, `findings` |

Common to all: `type`, `seq` (strictly increasing integer), `at` (UTC RFC 3339),
`worker`.

See [`examples/relay.jsonl`](./examples/relay.jsonl) for a full rotation with a
mid-session cutoff.

## What's in here

| Path | |
| --- | --- |
| [`SPEC.md`](./SPEC.md) | the normative protocol |
| [`schema/worklog.schema.json`](./schema/worklog.schema.json) | JSON Schema (draft 2020-12) for one record |
| [`tools/verify-worklog.mjs`](./tools/verify-worklog.mjs) | zero-dependency reference validator |
| [`tools/schema-check.mjs`](./tools/schema-check.mjs) | schema validation (needs ajv) — for CI / other tooling |
| [`examples/`](./examples/) | relay-with-cutoff, solo session, hard cutoff |
| [`integrations/`](./integrations/) | Claude Code / Codex / generic snippets, a `prepare-commit-msg` hook |
| [`docs/rationale.md`](./docs/rationale.md) | design decisions & FAQ |
| [`docs/adoption.md`](./docs/adoption.md) | adding AHP to an existing project |

## Why not just…

- **…read the commit messages?** They don't cover uncommitted work, deliberate
  non-choices, or catch an over-claimed "done". See
  [rationale](./docs/rationale.md).
- **…keep an editable `HANDOFF.md`?** No history, no blame, and two agents across
  a rotation clobber it. Append-only + `seq` fixes that.
- **…use timestamps for order?** Three runtimes on two machines don't agree on
  the clock. `seq` is a monotone integer.

## Status

Draft, `0.1.0`. Record fields may still change before `1.0`. Follows
[SemVer](https://semver.org/); breaking changes are a major bump and land in
[`CHANGELOG.md`](./CHANGELOG.md).

## Origin

Extracted from a real project that rotates several coding agents under usage
limits. The project's specifics aren't in here — what's left is the part that
generalizes.

## License

[MIT](./LICENSE) © Nonosword
