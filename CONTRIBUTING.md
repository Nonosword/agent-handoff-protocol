# Contributing

AHP is a small protocol with a small reference implementation. The bar for
changing the record shape or a required procedure is high; the bar for docs,
examples, integrations and tooling is low.

## Layout

| | |
| --- | --- |
| `SPEC.md` | the normative protocol |
| `schema/worklog.schema.json` | machine contract for one record |
| `src/` | the `ahp` CLI + `ahp-mcp` server (zero runtime deps, Node ≥ 20) |
| `bin/` | entry points |
| `tools/` | standalone file validator, schema check |
| `skills/`, `integrations/` | how agents reach `ahp` |
| `examples/` | worklogs that must pass `node tools/verify-worklog.mjs --file <p>` |
| `test/run.mjs` | end-to-end suite |

## Ways to help

- **Integrations** for more agents / harnesses.
- **Ports** of `ahp` or of `tools/verify-worklog.mjs` to other languages —
  behaviour-compatible, dependency-light.
- **Real-world examples** — anonymised worklogs showing a tricky case.
- **Rationale / FAQ** entries when a question recurs.

## Changing the protocol

Open an issue first. A change to `SPEC.md` §4–§9 or `schema/worklog.schema.json`:

- updates `SPEC.md`, the schema, `src/validate.mjs`, `tools/verify-worklog.mjs`
  and `examples/` together, in one PR;
- states the migration story for existing worklogs;
- bumps the version per SemVer (breaking record/procedure change = major) and
  updates `CHANGELOG.md`.

Design constraints not to trade away without a strong reason:

- Git is authoritative for *what changed*; the worklog never duplicates it.
- Append-only, single active writer, ordered by integer `seq` (not timestamps).
- The worklog is process state — never VCS-tracked, never in a product gate.
- A worker cannot assume a clean shutdown; recovery must work from
  `handoff.start` + VCS + open intents alone.
- Zero runtime dependencies in `src/`.

## Before you push

```sh
npm test
npm run verify:examples
npm install --no-save ajv@8 ajv-formats@3 && npm run schema:check
./install.sh --mode skill --dry-run
```

No CLA. Contributions are under the repository's MIT license.
