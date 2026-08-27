# Changelog

All notable changes to the Agent Handoff Protocol are documented here. The
protocol version follows [Semantic Versioning](https://semver.org/): a breaking
change to record shape or required procedure is a major bump.

## [0.1.0] — 2026-08-27

Initial public draft.

- `SPEC.md` — the normative protocol: worklog file rules, four record types
  (`handoff.start`, `handoff.end`, `intent.open`, `intent.promote`), pickup /
  working / drop procedures, recovery table, retention, security notes,
  conformance.
- `schema/worklog.schema.json` — JSON Schema (draft 2020-12) for a single record.
- `tools/verify-worklog.mjs` — zero-dependency reference validator.
- `examples/` — relay (with a cutoff), solo session, hard cutoff with no
  `handoff.end`.
- `integrations/` — Claude Code, Codex, generic agent snippets; a
  `prepare-commit-msg` reminder hook.
- Bilingual README (English / 简体中文).

Status: **draft**. Record fields may still change before 1.0.
