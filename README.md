# Agent Handoff Protocol (AHP)

**English** · [简体中文](./README.zh-CN.md)

[![ci](https://github.com/Nonosword/agent-handoff-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/Nonosword/agent-handoff-protocol/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![spec: 0.2.0](https://img.shields.io/badge/spec-0.2.0%20draft-orange.svg)](./SPEC.md)

> An append-only worklog so rotated coding agents don't lose the thread when one
> hits its usage limit and the next takes over. Kept in a store **outside** your
> project — your repo is never touched.

## The problem

You run several coding agents against one repo — Codex, Claude, a local model —
and rotate them as each hits its usage limit. An agent often gets cut off
**mid-edit**, with no chance to explain itself. The next agent inherits an
uncommitted diff with no context, commits that show *what* changed but not what
was skipped or what came next, and — if it trusts a hand-written summary — a
decent chance that summary is wrong.

## The idea

Split the record in two, by what each medium is good at:

| Question | Answered by |
| --- | --- |
| What files changed, in which commits? | **Git history** |
| What was each change *for*? | worklog — `intent.*` |
| What's unfinished or uncommitted *right now*? | worklog — an `intent.open` with no `intent.promote` |
| Where are the hazards and shortcuts? | worklog — `landmines` |
| What should the next agent do? | worklog — `next` / `plan` |

```
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

The worklog is one JSON-Lines file per project, **append-only**, ordered by an
integer `seq`, living in a per-user store at
`$XDG_DATA_HOME/agent-handoff/` — keyed by the project's Git identity, so it
works from any subdirectory and after a re-clone. Nothing is added to your repo.
(An in-repo `.coworker/worklog.jsonl` is also a valid layout — see [SPEC §4.3](./SPEC.md).)

## Install

```sh
git clone https://github.com/Nonosword/agent-handoff-protocol ~/Repositories/agent-handoff-protocol
cd ~/Repositories/agent-handoff-protocol
./install.sh
```

The installer walks through it with a step-by-step report — symlinks the
`ahp` / `ahp-mcp` CLIs onto your PATH and checks each runs, creates and probes
the store, deploys the **workflow** (the Claude Code skill + Codex `AGENTS.md`
snippet), then (arrow keys) asks whether agents should also get native `ahp_*`
tools:

- **cli** — agents run the `ahp` CLI; the skill / snippet teach the sequence.
- **mcp** *(recommended)* — the above, plus `ahp-mcp` registered as an MCP
  server with each detected host (`claude mcp add` / `codex mcp add`), so agents
  call `ahp_pickup`, `ahp_start`, … directly. Structured arguments — no shell
  quoting of the free-text fields.

An agent with both prefers the MCP tools and falls back to the CLI. `./install.sh
--mode cli|mcp` skips the prompt · `--dry-run` · `--no-color` · `--uninstall`.

Requires Node ≥ 18.17 and Git.

## Use it

From inside any Git repo:

```sh
ahp status          # project, baton holder, open intents, tree/gate state
ahp pickup          # guided pickup: last handoff, commits since, open intents
ahp start   --plan "add rate limiting" --gate pass --evidence "188 tests pass"
ahp intent open   --id i-0828-a --title "token bucket" --intended "per-IP, 429 on exhaustion"
ahp intent promote --id i-0828-a --commit 9f2e1df --gate pass \
  --actual "middleware + 6 tests" --landmine "in-process only" --next "shared-cache state"
ahp end     --reason limit --summary "1 of 3 commits landed" --gate pass --evidence "194 pass"
```

The first `ahp` command in a repo auto-registers it. `ahp` fills in `seq`, the
timestamp, the base commit and tree state from Git — you supply the meaning.

## Records

Four types. Full field tables in [`SPEC.md`](./SPEC.md) §5; machine contract in
[`schema/worklog.schema.json`](./schema/worklog.schema.json).

| type | when | carries |
| --- | --- | --- |
| `handoff.start` | picking up the baton | `base` (verified commit + gate + tree), `plan`, `continuesFrom` |
| `intent.open` | before a commit | `intentId`, `title`, `intended` |
| `intent.promote` | after it lands green | `commits`, `gate`, `actual`, `landmines`, `next` |
| `handoff.end` | stopping (best-effort) | `reason`, `end` (commit + gate), `summary`, `findings` |

See [`examples/relay.jsonl`](./examples/relay.jsonl) for a full rotation with a
mid-session cutoff.

## What's in here

| Path | |
| --- | --- |
| [`SPEC.md`](./SPEC.md) | the normative protocol |
| [`bin/ahp`](./bin/ahp), [`src/`](./src/) | the reference CLI |
| [`bin/ahp-mcp`](./bin/ahp-mcp) | the MCP server |
| [`schema/worklog.schema.json`](./schema/worklog.schema.json) | JSON Schema for one record |
| [`skills/claude-code/`](./skills/claude-code/) | Claude Code skill |
| [`integrations/`](./integrations/) | Codex snippet, MCP config, generic prompt, git hook |
| [`tools/verify-worklog.mjs`](./tools/verify-worklog.mjs) | standalone file validator |
| [`examples/`](./examples/) | relay-with-cutoff, solo, hard cutoff |
| [`docs/`](./docs/) | [rationale & FAQ](./docs/rationale.md), [adoption](./docs/adoption.md) |

## Why not just…

- **…read the commit messages?** They don't cover uncommitted work, deliberate
  non-choices, or catch an over-claimed "done". See [rationale](./docs/rationale.md).
- **…keep an editable `HANDOFF.md`?** No history, no blame, and two agents across
  a rotation clobber it. Append-only + `seq` fixes that.
- **…use timestamps for order?** Three runtimes on two machines don't agree on
  the clock. `seq` is a monotone integer.

## Status

Draft, `0.2.0`. Record fields may still change before `1.0`. Follows SemVer;
breaking changes are a major bump and land in [`CHANGELOG.md`](./CHANGELOG.md).

## Origin

Extracted from a real project that rotates several coding agents under usage
limits. The project's specifics aren't in here — what's left is the part that
generalizes.

## License

[MIT](./LICENSE) © Nonosword
