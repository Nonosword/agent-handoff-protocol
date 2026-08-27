# Adopting AHP

## Install once, per machine

```sh
git clone https://github.com/Nonosword/agent-handoff-protocol ~/Repositories/agent-handoff-protocol
cd ~/Repositories/agent-handoff-protocol && ./install.sh
```

Pick **skill** (agents run the `ahp` CLI) or **mcp** (agents call tools). Nothing
is written into any project you work on — the worklog lives in
`$XDG_DATA_HOME/agent-handoff/`, one file per project.

## Per project — nothing to do

The first `ahp` command run inside a Git repo auto-registers it, keyed by the
repo's `origin` remote (or its path if there's no remote). `ahp project list`
shows what's registered; `ahp project rename <id> <name>` sets a friendly name.

If you *want* the worklog in the repo instead (co-located, travels with a
tarball), that's a valid layout too — see [SPEC §4.3](../SPEC.md). Add
`.coworker/` to the project's `.gitignore` and point your tooling there.

## Tell your agents

**skill mode** installed a Claude Code skill and/or a Codex `AGENTS.md` block —
agents pick it up automatically. For another harness, paste
[`integrations/generic-agent.md`](../integrations/generic-agent.md) into its rules
file.

**mcp mode** registered the server. Add one line to the agent's instructions:
*"At session start call `ahp_pickup`, reconcile, then `ahp_start`. One
`ahp_intent_open` / `ahp_intent_promote` per commit. `ahp_end` when stopping."*

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
