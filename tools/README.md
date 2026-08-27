# verify-worklog

Zero-dependency reference validator for an [AHP](../SPEC.md) worklog.

```
node verify-worklog.mjs [--file <path>] [--root <dir>] [--strict] [--quiet]
```

| Flag | Meaning |
| --- | --- |
| `--file <path>` | worklog path (default `<root>/.coworker/worklog.jsonl`; env `AHP_WORKLOG` also works) |
| `--root <dir>` | repository root (default: current directory) |
| `--strict` | treat warnings as errors (use in CI) |
| `--quiet` | print only on error |

Exit codes: `0` ok / absent / warnings-without-strict · `1` structural or lifecycle
error · `2` usage error.

## What it checks

- JSON Lines shape; one object per line
- required fields per record type (SPEC §5)
- `seq` strictly increasing (SPEC §4.2)
- intent lifecycle (SPEC §6): every `intent.promote` has a prior `intent.open`;
  no double open/promote; a `gate: "fail"` promote lists `landmines`
- handoff pairing: `handoff.end` needs an open `handoff.start`; a non-`pass` end
  carries `findings`
- reports intents left open — the pointer to unfinished / uncommitted work

## What it does not check

It never runs Git. The Git cross-checks — base commit is an ancestor of HEAD,
promoted commits are reachable — are pickup-sequence steps a worker runs directly
(`git log <base>..HEAD`), per SPEC §7.1.

## Run it

At **pickup** (after reading the log, before writing your `handoff.start`) and
before **drop**. A project may also wire it into a `pre-commit` hook or CI with
`--strict`.

```sh
# from your project root
node path/to/verify-worklog.mjs
```
