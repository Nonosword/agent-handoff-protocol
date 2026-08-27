# Adopting AHP in a project

## 1. Ignore the worklog

Add to your project's `.gitignore`:

```
.coworker/
```

## 2. Point your agents at the protocol

Add a short section to whatever file your agent reads on startup — `CLAUDE.md`,
`AGENTS.md`, `.cursorrules`, a system prompt. Copy from
[`integrations/`](../integrations/). The essential instruction:

> Before any change, run the AHP **pickup** sequence (SPEC §7.1): read
> `.coworker/worklog.jsonl`, reconcile commits since the last `handoff.start`
> against `intent.promote` records, adopt or set aside any open intent, re-verify
> the tree and the gate, then append your own `handoff.start`. Work in small
> single-intent commits, each `intent.open` before and `intent.promote` after.
> Best-effort `handoff.end` when you stop.

## 3. Make the validator runnable

Vendor `tools/verify-worklog.mjs` (it has no dependencies) or reference it, and
add a script:

```json
{ "scripts": { "worklog:check": "node tools/verify-worklog.mjs" } }
```

Agents run it at pickup and before drop. Optionally add `--strict` to CI or a
`pre-commit` hook (see [`integrations/git-hooks/`](../integrations/git-hooks/)).

**Do not** put it in the same gate that decides whether the *product* is
shippable — the worklog is process state and is absent on CI checkouts anyway.
Keep it a separate, advisory command.

## 4. First run

The first worker after adoption creates `.coworker/worklog.jsonl` with a single
`handoff.start` where `continuesFrom` is `null`. See
[`examples/solo.jsonl`](../examples/solo.jsonl).

## 5. Retention

When the file gets long, move the oldest whole sessions to
`.coworker/worklog.archive/<firstSeq>-<lastSeq>.jsonl`. Keep the last completed
session and every un-promoted intent in the live file. Never edit existing lines.

## Optional: enforce the doc's presence

If your project has its own documentation/architecture gate, you can require that
your agent-instructions file contains the pickup instruction and that
`verify-worklog` is wired up — so the protocol can't silently fall out of the
project. This is a project choice, not part of AHP.
