# tools/

Helpers that are not the main `ahp` CLI.

## verify-worklog.mjs

Validate an AHP worklog **file** directly (structural + lifecycle). For
project-aware validation use `ahp verify`; use this standalone form in CI, a
hook, or against an archived span.

```
node tools/verify-worklog.mjs --file <path> [--strict] [--quiet]
```

Exit: `0` ok / absent / warnings-without-strict · `1` error · `2` usage. Shares
its logic with the CLI (`../src/validate.mjs`).

## schema-check.mjs

Validate records against [`schema/worklog.schema.json`](../schema/worklog.schema.json).
Needs `ajv` — used in CI and by downstream tooling that wants a trusted schema
result.

```
npm install --no-save ajv@8 ajv-formats@3
node tools/schema-check.mjs examples/*.jsonl
```

## git hook

A `prepare-commit-msg` reminder hook lives at
[`../integrations/git-hooks/prepare-commit-msg`](../integrations/git-hooks/prepare-commit-msg).
