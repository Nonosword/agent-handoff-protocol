# Codex — AGENTS.md snippet

`install.sh` appends this block to `~/.codex/AGENTS.md` (option A). Paste it into
a project's `AGENTS.md` instead if you want it per-project.

```markdown
## Agent Handoff Protocol

Session continuity across agent rotations. An append-only worklog in a central
store outside this repo — the repo is never modified.

If the `ahp_*` MCP tools are available this session, use those (structured
arguments, no shell quoting of the free-text fields). Otherwise use the `ahp`
CLI below. Same steps, same order; `ahp <verb>` maps to the `ahp_<verb>` tool.

Identify yourself so records aren't attributed to "unknown": via MCP this is
automatic; via the CLI, `export AHP_WORKER_ID=codex AHP_MODEL=codex
AHP_RUNTIME=codex-cli` once, or pass `--worker-id/--model/--runtime` on `ahp start`.

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
`ahp status` / `ahp log` / `ahp verify` / `ahp --help` for the rest.
```
