# Generic agent / system prompt

For any agent (or human) that can run a shell command. Requires `ahp` on PATH
(the project's `install.sh` handles this) — or an MCP host, see `mcp.md`.

## Drop into the system prompt / rules file

```
CONTINUITY — this workspace uses the Agent Handoff Protocol. The worklog lives
outside the repo, in a central store keyed by the repo's Git identity. `ahp`
manages it; the repo is never touched.

If `ahp_*` MCP tools are available, prefer them over the `ahp` shell commands
(structured args, no quoting of the free-text fields). `ahp <verb>` ↔ `ahp_<verb>`.

At the start of a session, before editing anything:
  1. Run `ahp pickup`. It shows the last handoff, the commits since its base,
     which are accounted for, and any OPEN INTENTS (declared work not yet
     promoted = probably uncommitted).
  2. For each open intent, inspect the working tree and decide: finish it,
     `wip:`-commit + promote it, or stash it.
  3. Run the project's own gate (tests/lint/build). Then:
     `ahp start --plan "<what you intend>" --gate pass|fail|not-run --evidence "<proof>"`

While working — one intent per commit:
  `ahp intent open --id <id> --title "<t>" --intended "<what & why>"`
  ...make the commit, run the gate...
  `ahp intent promote --id <id> --commit <sha> --gate pass --actual "<did>" --landmine "<hazard>" --next "<next>"`

Before stopping (you may be cut off without warning):
  `ahp end --reason limit --summary "<recap>" --gate pass --evidence "<proof>" [--finding "<hazard>"]`

Never cross a commit boundary with a dirty tree that no open intent describes.

The worklog is session continuity, not project memory. A landmine / next /
finding is about the work in flight; a fact that outlives the session (an
invariant, a "never do X") goes in the project's own docs, not the worklog.

`ahp dashboard` shows every project at once — baton, open intents, drift — and
is the one command that runs outside a repo (`-w` live, `--json` for scripts).
```

## Reference

`ahp --help` · [`../SPEC.md`](../SPEC.md) for the record format.
