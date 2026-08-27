<!-- Thanks for contributing to AHP. -->

## What & why

<!-- One or two sentences. Link an issue if there is one. -->

## Type

- [ ] docs / examples / integration / tooling (low bar)
- [ ] change to `SPEC.md` §4–§7 or `schema/worklog.schema.json` (needs a prior issue; see below)

## If this changes the protocol

- [ ] `SPEC.md`, `schema/worklog.schema.json`, `tools/verify-worklog.mjs` and `examples/` updated together
- [ ] migration story for existing worklogs stated below
- [ ] version bumped per SemVer, `CHANGELOG.md` updated

## Checks

- [ ] `for f in examples/*.jsonl; do node tools/verify-worklog.mjs --file "$f"; done` passes
- [ ] `cd tools && npm test` passes
