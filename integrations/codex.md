# Codex / AGENTS.md

## AGENTS.md snippet

Add to your project's `AGENTS.md`:

```markdown
## Agent Handoff Protocol

This repo uses AHP (https://github.com/Nonosword/agent-handoff-protocol).
Continuity record: `.coworker/worklog.jsonl` — JSON Lines, append-only, not tracked by git.

PICKUP — do this before the first change (AHP SPEC §7.1):
- Read the worklog. Find the last `handoff.start` → `base.commit`; note the highest `seq`.
- `git log --oneline <base.commit>..HEAD`; every commit should map to an `intent.promote`, and vice versa.
- Any `intent.open` without a matching `intent.promote` points at unfinished work — inspect the working tree, then finish / `wip:`-commit / stash it and note the disposition.
- Run the project gate and `git status` yourself; record what you observe.
- Append `handoff.start` with the verified `base` and your `plan`.

WORK: one intent per commit. `intent.open` before, `intent.promote` after it passes the gate — include `actual`, `landmines`, `next`.

DROP (best-effort, you may be cut off): reach a green commit, promote finished intents, append `handoff.end` with `reason`, `end`, `summary`, `findings`.

Validate: `node tools/verify-worklog.mjs` at pickup and before stopping.

Because a run can end without warning, never leave the tree dirty across a commit boundary unless an open intent describes it.
```

## Record shape

See [`../SPEC.md`](../SPEC.md) §5 and [`../examples/`](../examples/). Minimum
`handoff.start`:

```json
{"type":"handoff.start","seq":N,"at":"<UTC RFC3339>","worker":{"id":"...","model":"codex","runtime":"codex-cli"},"continuesFrom":<seq|null>,"base":{"commit":"<sha>","gate":"pass","gateEvidence":"...","treeClean":true,"verifiedBy":"self"},"plan":"..."}
```
