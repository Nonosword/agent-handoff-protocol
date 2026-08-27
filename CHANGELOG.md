# Changelog

Protocol version follows [Semantic Versioning](https://semver.org/); a breaking
change to record shape or required procedure is a major bump.

## [0.2.0] — 2026-08-27

The protocol becomes storage-location-agnostic and ships a real CLI.

### Added

- **`ahp` CLI** (zero runtime dependencies) — `status`, `pickup`, `start`,
  `intent open|promote`, `end`, `read`, `log`, `verify`, `project`, `compact`,
  `path`. Assigns `seq` / `at` and captures Git state (`base.commit`, tree
  cleanliness) so a worker only supplies the semantic content.
- **External store binding** — the worklog lives in a per-user store
  (`$XDG_DATA_HOME/agent-handoff/`), one file per project, keyed by the
  project's Git identity (normalized remote URL, else repo path + hash). The
  project repository is never touched. In-repo `.coworker/worklog.jsonl` remains
  a valid binding (SPEC §4.3).
- **Project registry** — `projects.json` records name, remote and every local
  path a project has been seen at, so a moved checkout still resolves.
- **`ahp-mcp`** — Model Context Protocol server over stdio (zero deps): tools
  `ahp_status`, `ahp_pickup`, `ahp_start`, `ahp_intent_open`,
  `ahp_intent_promote`, `ahp_end`, `ahp_read`, `ahp_verify`.
- **`install.sh`** — one-command deploy with a structured, coloured, step-by-step
  report (every action logs a line; TUI-style sections and status markers) and an
  arrow-key mode picker. Symlinks the CLIs and verifies each runs, creates and
  probes the store, **always deploys the workflow** (Claude Code skill + Codex
  `AGENTS.md` snippet), then in `mcp` mode also registers the MCP server with
  **each host via `claude mcp add --scope user` / `codex mcp add`** (idempotent,
  confirmed with `… mcp get`, warns on a pre-existing local/project-scoped
  entry) and self-tests it. Offers to add the bin dir to your shell rc; finishes
  with a self-test. `--mode cli|mcp`, `--dry-run`, `--no-color`, `--uninstall`
  (which also runs `… mcp remove` at every scope).
- **Interface preference** — the skill, the Codex snippet and the generic
  prompt all tell an agent: if the `ahp_*` MCP tools are present, use them
  (structured arguments); otherwise the `ahp` CLI. `ahp <verb>` ↔ `ahp_<verb>`.
- **Claude Code skill** (`skills/claude-code/agent-handoff-protocol/`).
- **Per-project write lock** with stale-lock reclaim; `fsync` on every append.
- End-to-end test suite (`test/run.mjs`).

### Changed

- `SPEC.md` §4 rewritten: worklog properties are separated from storage location;
  new §4.3 (storage bindings) and §4.4 (project identity). Procedures now name
  the reference `ahp` command for each step.
- `--gate` is required on `start` and `end` (was optional).
- Record field for a starting/ending state uses `commit` (was `sha` in drafts).
- `tools/verify-worklog.mjs` now shares `src/validate.mjs` with the CLI.

## [0.1.0] — 2026-08-27

Initial public draft: `SPEC.md`, JSON Schema, zero-dep file validator, examples,
integration snippets, bilingual README.
