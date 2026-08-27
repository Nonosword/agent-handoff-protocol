# Claude Code

## CLAUDE.md snippet

Add to your project's `CLAUDE.md` (or `~/.claude/CLAUDE.md` for all projects):

```markdown
## Agent Handoff Protocol

This repo uses AHP (https://github.com/Nonosword/agent-handoff-protocol).
The worklog is `.coworker/worklog.jsonl` — append-only, not git-tracked.

Before your first change this session (PICKUP — AHP SPEC §7.1):
1. Read `.coworker/worklog.jsonl`; note the last `handoff.start` and its `base.commit`, and the highest `seq`.
2. `git log --oneline <base.commit>..HEAD` — reconcile each commit against an `intent.promote`.
3. For every `intent.open` with no `intent.promote`: check `git status` / `git diff` for matching uncommitted work; finish it, commit it `wip:` with a promote, or stash it and record that.
4. Run the gate (`<your test/lint command>`) and `git status` yourself. Trust what you observe, not the log.
5. Append a `handoff.start` (seq = last + 1) with the verified `base` and your `plan`.

While working: small single-intent commits. `intent.open` before each, `intent.promote` (with `actual`, `landmines`, `next`) after each lands green.

When stopping (best-effort): move to a green commit, promote finished intents, append `handoff.end`.

Run `node tools/verify-worklog.mjs` at pickup and before stopping.
```

## Optional: a SessionStart hook

`.claude/settings.json` — surface the last handoff automatically at session start:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "tail -n 3 .coworker/worklog.jsonl 2>/dev/null; node tools/verify-worklog.mjs --quiet || true"
          }
        ]
      }
    ]
  }
}
```

This prints the last few worklog records and any validator errors into the
session context so the pickup sequence starts from a real view.
