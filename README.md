# Agent Handoff Protocol (AHP)

**English** · [简体中文](./README.zh-CN.md)

[![ci](https://github.com/Nonosword/agent-handoff-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/Nonosword/agent-handoff-protocol/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

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

**Pickup is identity-agnostic.** It anchors to the *last handoff*, not to "your"
last commit — so when you resume after another agent (or your own limit reset)
has moved things, you reconcile *their* commits and carry on forward, rather than
resuming from a stale plan in your memory. `ahp pickup` says so when it spots a
prior turn of yours. The worklog is session continuity, not a per-agent journal:
a constraint that outlives a session belongs in the project's own docs, and
`ahp log --worker <id>` still shows any one agent's full trail.

A **Project** identifies the Git repository; a **Lane** identifies one coherent
work stream inside it. Each Lane has its own append-only JSON-Lines worklog and
baton, ordered by integer `seq`, in the per-user store at
`$XDG_DATA_HOME/agent-handoff/`. Existing project-wide logs remain available as
the synthetic `main` Lane. Nothing is added to your repo. See [SPEC §4](./SPEC.md).

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
  server with each detected host — Claude Code / Codex via their own `mcp add`
  CLI (one Codex entry also covers the ChatGPT desktop app and IDE extension);
  Claude Desktop, Cursor, VS Code and Windsurf by merging into each
  application's dedicated MCP config file (never touching anything else in it);
  Qoder via its `mcp add` CLI; and Qoder CN via its separate
  `qoder-cn --add-mcp <JSON>` CLI — so agents call
  `ahp_project_list`, `ahp_pickup`, `ahp_start`, … directly. Structured arguments — no shell
  quoting of the free-text fields.

An agent with both prefers the MCP tools and falls back to the CLI.
`./install.sh --mode cli|mcp` skips the prompt · `--dry-run` · `--no-color` ·
`--uninstall`.

Requires Node ≥ 20 and Git.

## Use it

From inside any Git repo, after resolving the matching Lane (the first `start`
may omit `--lane` only when no active or done Lane exists):

```sh
ahp lane list
ahp status  --lane rate-limiting     # project, baton, intents, tree/gate state
ahp pickup  --lane rate-limiting     # add --full only when detail is needed
ahp start   --lane rate-limiting --plan "add rate limiting" --gate pass --evidence "188 tests pass"
ahp intent open --lane rate-limiting --id i-0828-a --title "token bucket" --intended "per-IP, 429 on exhaustion"
ahp intent promote --lane rate-limiting --id i-0828-a --commit 9f2e1df --gate pass \
  --actual "middleware + 6 tests" --landmine "in-process only" --next "shared-cache state"
ahp end --lane rate-limiting --reason limit --summary "1 of 3 commits landed" --gate pass --evidence "194 pass"
```

Read commands such as `status` and `pickup` never write merely to discover a
project. The first write command auto-registers it. `ahp` fills in `seq`, the
timestamp, the base commit and tree state from Git — you supply the meaning.

### Project and Lane selection

Project detection stays automatic. Within that Project:

1. `ahp lane list` returns `active` and `done` Lanes, so an agent can reuse or
   reopen completed work instead of creating a near-duplicate. `--all` also
   includes intentionally hidden `archived` Lanes.
2. With no `active` or `done` Lane, the first `ahp start` creates one from its
   plan. A sole `active` Lane — or exactly one active Lane already held by this
   worker — is selected automatically.
3. When the task clearly matches a Lane's id, title, description, scope or alias,
   the agent passes `--lane <id>` (or the MCP `lane` field).
4. If several Lanes remain plausible, AHP lists them plus **Create a new Lane**;
   the agent asks the operator only when it cannot decide reliably.

Carry the same explicit Lane through `pickup`, `start` and later writes; after it is the only Lane held by you, auto-selection can safely take over.
Use `ahp lane list`, `ahp lane create`, and `ahp lane edit` to inspect or refine
the metadata. Lane status has three user-facing values:

- `active` accepts worklog writes and is expanded in the Dashboard.
- `done` is complete but remains discoverable. `ahp start --lane <id>` explicitly
  reopens it as `active`; an implicit `start` shows it as a choice instead.
- `archived` is complete and hidden from default lists and the Dashboard. Use
  `lane list --all`, then `lane edit <id> --status active|done` to restore it.

Changing a Lane to `done` or `archived` requires a free baton, no open intents,
and a clean strict verification result. AHP never archives by age. Historical
`blocked` registry values remain readable but must be changed to `active` or
`done` before new writes. Agents propose concise Lane descriptions; humans may
edit them. The synthetic `main / legacy` Lane has the same lifecycle controls;
only its fixed title, description, scope, aliases, id, and historical worklog
path remain immutable.
`handoff.end --reason task-done` releases the session baton but does not change
Lane status. When the whole Lane is complete, follow it with
`ahp lane edit <id> --status done`. If immutable historical records fail strict
verification, an operator may preserve and acknowledge the exact worklog with
`--operator-disposition "<reason>"`; AHP stores its SHA-256 and the reviewed
errors in Lane metadata.
Agents must never invent that disposition, and AHP never silently ignores the
underlying verification result.
A commit may legitimately be promoted by intents in multiple Lanes: AHP records
associations, not commit ownership, and performs no semantic commit deduplication.
The agent still decides whether the work needs its own branch/worktree or can
follow the current branch; AHP does not choose or enforce a Git strategy.

Only the current Lane baton holder may append `intent.open`, `intent.promote`,
or `handoff.end`. A different worker must not finish another session: run
`pickup`, then use `start` to deliberately take over after reconciliation. That
new holder may complete an inherited open intent; `start` remains the valid
hard-cutoff recovery path.

If a required AHP action fails, it did not happen. Keep the project unchanged,
follow the error's target/evidence/next-step diagnostics, obtain filesystem or
sandbox access as needed, and retry until the CLI exits 0 (or the MCP result is
not an error). Never silently substitute an in-repo worklog.
An explicit `--project` on a write must identify a registered Project. Desktop
agents discover those ids with MCP `ahp_project_list`; passing `--cwd` inside a
checkout remains the automatic registration path. Unknown ids are rejected so
they cannot create worklogs hidden from the Dashboard.

From **anywhere** — every project at a glance:

```sh
ahp dashboard       # active Lanes expanded; done Lanes counted; archived hidden
                    # plus branch and short HEAD (no working-tree/log scan)
ahp dashboard -w    # redraw on local AHP state changes; fixed timestamps need no polling
ahp dashboard --json
```


Dashboard uses neutral ANSI-256 grey `38;5;248` for auxiliary text, so Tabby does not depend on its unusually dark ANSI bright-black mapping. Separator rules remain a separate ANSI `90` token, preserving their lower visual weight.

The interactive view shows the human-readable Lane title; its stable slug remains
available to CLI/MCP callers and JSON. A baton dot and open-intent count are
separate state: `0 open` is omitted, while a positive count remains visible.

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
| [`install.sh`](./install.sh) | one-command deploy (`--mode cli\|mcp`, `--dry-run`, `--uninstall`) |
| [`bin/ahp`](./bin/ahp), [`src/`](./src/) | the reference CLI |
| [`bin/ahp-mcp`](./bin/ahp-mcp) | the MCP server |
| [`schema/worklog.schema.json`](./schema/worklog.schema.json) | JSON Schema for one record |
| [`skills/claude-code/`](./skills/claude-code/) | Claude Code skill |
| [`integrations/`](./integrations/) | Codex snippet, MCP config, generic prompt, git hook |
| [`tools/verify-worklog.mjs`](./tools/verify-worklog.mjs) | standalone file validator |
| [`examples/`](./examples/) | relay-with-cutoff, solo, hard cutoff |
| [`docs/`](./docs/) | [rationale & FAQ](./docs/rationale.md), [adoption](./docs/adoption.md), [networked server (planned)](./docs/networked-server.md) |

## Why not just…

- **…read the commit messages?** They don't cover uncommitted work, deliberate
  non-choices, or catch an over-claimed "done". See [rationale](./docs/rationale.md).
- **…keep an editable `HANDOFF.md`?** No history, no blame, and two agents across
  a rotation clobber it. Append-only + `seq` fixes that.
- **…use timestamps for order?** Three runtimes on two machines don't agree on
  the clock. `seq` is a monotone integer.

## Status

Pre-1.0 — record fields may still change. Changes are additive where possible
and land in [`CHANGELOG.md`](./CHANGELOG.md); a breaking record or procedure
change would be a major bump.

## Origin

Extracted from a real project that rotates several coding agents under usage
limits. The project's specifics aren't in here — what's left is the part that
generalizes.

## License

[MIT](./LICENSE) © Nonosword
