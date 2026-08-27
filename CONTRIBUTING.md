# Contributing

AHP is a small protocol. The bar for changing the record shape or the required
procedure is high; the bar for docs, examples, integrations and tooling is low.

## Ways to help

- **Integrations** for more agents / harnesses (`integrations/`).
- **Ports of the validator** to other languages — keep them dependency-light and
  behaviour-compatible with `tools/verify-worklog.mjs`.
- **Real-world examples** (`examples/`) — anonymised worklogs that show a tricky
  case. Every example must pass `node tools/verify-worklog.mjs --file <path>`.
- **Rationale / FAQ** entries when a question keeps coming up.

## Changing the protocol

Open an issue first. A change to `SPEC.md` §4–§7 or to `schema/worklog.schema.json`:

- must update `SPEC.md`, the JSON Schema, `tools/verify-worklog.mjs` and the
  examples together, in one PR;
- must state the migration story for existing worklogs;
- bumps the version per SemVer — a breaking record/procedure change is a major
  bump. Record it in `CHANGELOG.md`.

The design constraints that shouldn't be traded away without a strong reason:

- Git is authoritative for *what changed*; the worklog never duplicates it.
- Append-only, single active writer, ordered by integer `seq` (not timestamps).
- The worklog is process state — never VCS-tracked, never in the product gate.
- A worker cannot assume a clean shutdown; recovery must work from
  `handoff.start` + VCS + open intents alone.

## Before you push

```sh
for f in examples/*.jsonl; do node tools/verify-worklog.mjs --file "$f"; done
node tools/verify-worklog.mjs --file examples/relay.jsonl --strict
cd tools && npm install --no-save ajv@8 ajv-formats@3 && npm run schema:check
```

## Conduct

Be decent. Assume good faith. No CLA — contributions are under the repository's
MIT license.
