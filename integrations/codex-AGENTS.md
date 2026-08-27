# Codex — AGENTS.md snippet

`install.sh` appends this block to `~/.codex/AGENTS.md` (option A). Paste it into
a project's `AGENTS.md` instead if you want it per-project.

```markdown
## Agent Handoff Protocol

Session continuity across agent rotations. The `ahp` CLI keeps an append-only
worklog in a central store outside this repo — the repo is never modified.

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
