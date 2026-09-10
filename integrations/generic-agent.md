# Generic agent / system prompt

For any agent (or human) that can run a shell command. Requires `ahp` on PATH
(the project's `install.sh` handles this) — or an MCP host, see `mcp.md`.

## Drop into the system prompt / rules file

```
CONTINUITY — this workspace uses the Agent Handoff Protocol. A Project groups
independent Lane worklogs in a central store keyed by the repo's Git identity.
`ahp` manages them; the repo is never touched.

If `ahp_*` MCP tools are available, prefer them over the `ahp` shell commands
(structured args, no quoting of the free-text fields). `ahp <verb>` ↔ `ahp_<verb>`.

Pass `--worker-id <id> --model <id> --runtime <id>` on `ahp start` so records
are attributed (the MCP tools and a covered CLI host do this automatically);
later records in the session inherit it.

A required AHP action counts only after explicit success (CLI exit 0; MCP result
not marked as an error). If `pickup` or `start` fails, leave code, docs and
Git unchanged. Preserve the exact error, do only read-only diagnosis, follow its
permission/mount/sandbox guidance, then retry. Never silently switch to an
in-repo worklog or proceed from memory.

Resolve the Lane before the first change. Run `ahp lane list` to discover active
and done work. If the task clearly matches an id/title/description/scope/alias, select
it with `--lane <id>` (or the MCP `lane` field) without asking. If none matches,
create one with a concise title, description and scope. If several remain
plausible, show the listed Lanes plus New Lane and ask the user. With no active
or done Lane, `start` creates one from its plan; a sole active Lane or the sole
active Lane held by you is automatically selected. Carry the same explicit Lane through `pickup`, `start`
and later writes. Do not create a near-duplicate Lane. Only the selected Lane's current baton
holder may write an intent or `handoff.end`; a different worker must pickup and
start a new session before completing inherited work.

Default Lane discovery includes `active` and `done`; use `lane list --all` only
when archived history matters. Prefer active Lanes. Reopen a done Lane only with
an explicit `start --lane <id>`. Archived Lanes must be explicitly restored to
`active` or `done`; never archive by age. Legacy `blocked` Lane metadata is
read-only compatibility, not a status to set for new work.

At the start of a session, before editing anything:
  1. Run `ahp pickup` for the selected Lane. It shows the last handoff, a
     compact commit view, and OPEN INTENTS. Use `--full` only when omitted
     details are needed.
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

`ahp dashboard` shows every Project/Lane at once — baton, open intents, verify,
branch and short HEAD — and is the one command that runs outside a repo. `-w`
redraws only after state changes; `--json` is for scripts.
```

## Reference

`ahp --help` · [`../SPEC.md`](../SPEC.md) for the record format.
