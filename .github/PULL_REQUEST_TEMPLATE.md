<!-- Thanks for contributing to AHP. -->

## What & why

<!-- One or two sentences. Link an issue if there is one. -->

## Type

- [ ] docs / examples / integration / tooling (low bar)
- [ ] change to `SPEC.md` §4–§9 or `schema/worklog.schema.json` (needs a prior issue)

## If this changes the protocol

- [ ] `SPEC.md`, `schema/`, `src/validate.mjs`, `tools/verify-worklog.mjs`, `examples/` updated together
- [ ] migration story for existing worklogs stated below
- [ ] version bumped per SemVer, `CHANGELOG.md` updated

## Checks

- [ ] `npm test` passes
- [ ] `npm run verify:examples` passes
- [ ] `./install.sh --mode skill --dry-run` runs clean
