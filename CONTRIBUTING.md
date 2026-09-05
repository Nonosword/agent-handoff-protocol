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

## Touching `install.sh`

`install.sh` must run on a **stock macOS shell** — `/bin/bash` is 3.2 (2007) and
the coreutils are BSD. Assess every change for it, even one reported from Linux:

- no `read -t` with a fractional argument (3.2 rejects it); no `${var,,}`,
  associative arrays, `mapfile`, or `readlink -f`.
- `2>/dev/null` before a risky redirect on the same command, not after
  (`</dev/tty` on a machine with no controlling terminal errors otherwise).
- BSD `sed` / `awk` semantics; `sed -i` needs an arg.

Run `/bin/bash -n install.sh` and, ideally, `/bin/bash install.sh --dry-run`
under the real 3.2 before pushing.

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

Tidy the history first: squash the work-in-progress commits into a small set of
coherent ones (one per topic), each of which builds and passes on its own. CI
runs the suite on Linux (Node 20/22) and on macOS against the stock `/bin/bash`
3.2 — an `install.sh` change is not done until the macOS job is green.

No CLA. Contributions are under the repository's MIT license.
