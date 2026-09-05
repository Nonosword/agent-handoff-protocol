# Adopting AHP

## Install once, per machine

```sh
git clone https://github.com/Nonosword/agent-handoff-protocol ~/Repositories/agent-handoff-protocol
cd ~/Repositories/agent-handoff-protocol && ./install.sh
```

The workflow (Claude Code skill + Codex `AGENTS.md` snippet) is always deployed.
The mode choice — **cli** or **mcp** *(recommended)* — only decides whether
agents also get native `ahp_*` tools via an MCP server. Nothing is written into
any project you work on; the worklog lives in `$XDG_DATA_HOME/agent-handoff/`,
one file per project.

## Per project — nothing to do

The first `ahp` command run inside a Git repo auto-registers it, keyed by the
repo's `origin` remote (or its path if there's no remote). `ahp project list`
shows what's registered; `ahp project rename <id> <name>` sets a friendly name.

If you *want* the worklog in the repo instead (co-located, travels with a
tarball), that's a valid layout too — see [SPEC §4.3](../SPEC.md). Add
`.coworker/` to the project's `.gitignore` and point your tooling there.

## Tell your agents

The install deployed a Claude Code skill and/or a Codex `AGENTS.md` block —
agents pick those up automatically. For another harness, paste
[`integrations/generic-agent.md`](../integrations/generic-agent.md) into its rules
file.

All three carry the same guidance: **if the `ahp_*` MCP tools are present, use
them; otherwise run the `ahp` CLI.** So an agent with both installed prefers the
structured MCP path and falls back to the shell.

## Seeing everything at once

```sh
ahp dashboard        # every registered project: baton holder + plan, worklog
                     # counts, open intents, verify, git state, and drift
ahp dashboard -w     # live view (-n S to set the interval, ctrl-c to exit)
ahp dashboard --json # for scripts; exit 1 if any project errors or has drift
```

Unlike every other command it does **not** need to be run inside a repo — it
reads the store, so it works from anywhere and covers all projects at once.

## Worker identity

Set once in the agent's environment so every record is attributed:

```sh
export AHP_WORKER_ID=claude AHP_MODEL=claude AHP_RUNTIME=claude-code
```

Otherwise pass `--worker-id/--model/--runtime` on `ahp start`, or the identity is
inherited from the last `handoff.start`.

## Retention

`ahp compact --keep N` moves all but the last N sessions to
`<store>/projects/<id>/archive/`, keeping any still-open intent in the live file.
Run it when `ahp log` gets long. Records are only ever *moved*, never rewritten.

## Back up the store (optional)

The store is plain files. `git init` it and push to a private remote, or let
your normal home-dir backup cover `$XDG_DATA_HOME/agent-handoff/`.
