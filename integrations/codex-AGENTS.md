# Codex — AGENTS.md snippet

`install.sh` appends this block to `~/.codex/AGENTS.md` (option A). Paste it into
a project's `AGENTS.md` instead if you want it per-project.

```markdown
## Agent Handoff Protocol

Session continuity across agent rotations. A Project groups independent Lane
worklogs in a central store outside this repo — the repo is never modified.

If the `ahp_*` MCP tools are available this session, use those (structured
arguments, no shell quoting of the free-text fields). Otherwise use the `ahp`
CLI below. Same steps, same order; `ahp <verb>` maps to the `ahp_<verb>` tool.

A required AHP action counts only when it reports success (CLI exit 0; MCP
result not marked as an error). If `pickup` or `start` fails, do not change
code, docs or Git state. Preserve the exact error, perform only read-only
diagnosis, follow its permission/mount/sandbox guidance, then retry. Do not
silently switch to an in-repo worklog or proceed from memory.

Identify yourself so records aren't attributed to "unknown": via MCP this is
automatic; for the CLI, `install.sh` wires `AHP_WORKER_ID` into Codex's shell
environment. If a record still lands wrong, pass `--worker-id codex --model
codex --runtime codex` on `ahp start` — later records in the session inherit it.

Resolve the Lane before the first change. Run `ahp lane list` when more than one
exists. If the task clearly matches an id/title/description/scope/alias, select
it with `--lane <id>` (or the MCP `lane` field) without asking. If none matches,
create one with a concise title, description and scope. If several remain
plausible, show the listed Lanes plus New Lane and ask the user. With no Lane,
`start` creates one from its plan; a sole Lane or the sole Lane held by you is
automatically selected. Carry the same explicit Lane through `pickup`, `start`
and later writes. Do not create a near-duplicate Lane.

Only the worker holding the selected Lane baton may write an intent or
`handoff.end`. If AHP names a different holder, do not end or promote its
session: pickup, reconcile, then use `start` if you must deliberately take over.
That new holder may complete inherited open intents; `start` remains the normal
hard-cutoff recovery path.

BEFORE the first change this session:
  ahp pickup
Read it: last handoff, commits since its base, and open intents (declared work
with no promotion → probably uncommitted). For each open intent, check the tree
and finish / wip-commit / stash it. Run the project's gate yourself. Then:
  ahp start --plan "<intent>" --gate pass|fail|not-run --evidence "<proof>"

WHILE WORKING, one intent per commit:
  ahp intent open   --id i-<date>-<x> --title "<t>" --intended "<what & why>"
  ahp intent promote --id i-<date>-<x> --commit <sha> --gate pass \
     --actual "<what you did>" --landmine "<hazard>" --next "<follow-up>"

WHEN STOPPING (best-effort — you may be cut off):
  ahp end --reason limit --summary "<recap>" --gate pass --evidence "<proof>" \
     [--finding "<hazard for the next agent>"]

Never cross a commit boundary with a dirty tree that no open intent describes.

The worklog is session continuity, not project memory. A `landmine` / `next` /
`finding` is about *this* work in flight. A fact that outlives the session (an
invariant, a "never do X here") goes in the project's own docs — prefer editing
an existing one — not the worklog.

`ahp dashboard` (every Project/Lane at once — baton, open intents, verify,
branch + short HEAD; runs outside a repo; `-w` redraws on change; CLI only) /
`ahp status` / `ahp log` / `ahp verify` / `ahp --help` for the rest.
```
