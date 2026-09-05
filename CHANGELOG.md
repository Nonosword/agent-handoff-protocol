# Changelog

The current version is in [`package.json`](./package.json). It follows
[SemVer](https://semver.org/): a breaking change to the record shape or a
required procedure is a major bump. Releases are cut when they are cut; a
version without a date is the working state on `main`.

## 0.4.0 — 2026-09-04

One iteration after a week of real use: make the record unambiguous about *who*
and *which session*, make `verify` honest by default, and make the installer
safe on a stock machine. All additive — old worklogs still validate.

### Protocol

- **`sessionId` on every record + one baton projection.** `handoff.start` mints
  `<canonical-worker>-<yyyymmdd>-<seq>` (e.g. `codex-20260904-5`); `handoff.end`
  and the `intent.*` records written while that baton is held echo it. A
  consumer now reads baton state from one `baton` object
  (`{ sessionId, worker, phase: held|released, sinceSeq, since }`, SPEC §6.1)
  instead of re-folding the stream — the class of bug behind the 0.3.0
  `fix(status)` and the 22-`start` / 19-`end` ambiguity a week of use produced.
  `baton.sessionId` is synthesised by the same rule for a `handoff.start` that
  predates the field. SPEC §2 / §5 / §6.1, the schema, and the bundled examples
  updated.
- **One canonical worker id, shared by the CLI and the MCP server.** That week
  split one agent across `claude` (136) / `claude-code` (99) / `unknown` (10).
  `src/worker-detect.mjs` owns a small vocabulary (`WORKERS`) pairing each
  canonical id with the runtime spellings that fold to it; both entry points
  run identity through `canonicalWorkerId()` before attributing or filtering,
  and `--worker claude-code` matches records stored as `claude`. The `worker`
  object still carries a finer `runtime`. An unknown agent keeps its own
  sanitised name; only an absent identity is `unknown`. SPEC §2 gains an
  *Avoid:* list per term so the code and the spec cannot drift.
- **`ahp verify` is strict by default, three tiers.** *errors* (malformed /
  lifecycle-broken) stay fatal. *warnings* — well-formed but a quality problem
  (`pass` gate with no `gateEvidence`, non-RFC-3339 `at`, a baton not
  `verifiedBy: self`, an `intent.*` written with no baton held) — now fail
  `verify`; `--lenient` / `ahp_verify {lenient:true}` downgrades them. *notes* —
  expected valid situations (a hard cutoff; an intent open mid-work) — never
  fail, and the hard-cutoff note names the severed session's seq and points at
  `ahp pickup`. `--strict` stays accepted as a no-op. `tools/verify-worklog.mjs`
  matches. SPEC §12 rewritten around the tiers.
- **`src/lifecycle.mjs`** — one module owns the baton projection and the write
  preconditions (`assertCanOpen` / `assertCanPromote` / `assertCanEnd`), moved
  out of `cli.mjs` and `analyze()` so the CLI and anything that later appends
  agree on when a record is allowed.

### CLI / MCP

- **`ahp read --field <name>`** projects one field flat across matching
  records instead of whole records — e.g. `--field next`, or `--field
  landmines --tail 5` for the last 5 landmine strings regardless of which
  `intent.promote` they came from. `--field hazards` is a pseudo-field pulling
  `landmines` (`intent.promote`) and `findings` (`handoff.end`) together, in
  seq order — "what should the next worker watch out for" in one query.
  Composes with `--type` / `--worker` / `--since`; with `--field` set, `--tail`
  counts projected values, not records. `ahp_read` gained `field` and the
  previously CLI-only `worker` parameter.
- `ahp status --json` — the project's `baton`, open intents, git state and the
  three verify tiers, for scripts.
- `ahp log` heads each session with its `sessionId`.
- `ahp dashboard --json` per-project `baton` uses the same snapshot shape and is
  present for a `released` baton too, not only a held one; `verify.warnings` /
  `verify.notes` are arrays, matching `verify.errors`. The human view surfaces a
  warning count the way it already surfaces errors.
- **MCP: array-valued tool arguments were silently dropped.** `toArgv`'s
  `list()` helper pushed `--commit` / `--ref` / `--scope` / `--landmine` /
  `--finding` onto the globals array *after* it was spread into the command
  argv, so `ahp_intent_promote` with `commits` hit the CLI's `requires
  --commit`, and `ahp_intent_open` refs / `ahp_end` findings never landed.
- **`ahp <command> -h/--help` no longer errors** (`Unknown option '--help'`) —
  routed to the one reference.
- `ahp status` / `ahp pickup` no longer crash on a worklog with records but no
  `handoff.start`; both print a clear line instead. `ahp verify` sends a fatal
  warning to stderr (with the errors), advisory `--lenient` warnings to stdout.

### Installer

- **`install.sh --mode mcp` now also registers with Cursor, VS Code, Windsurf
  and Qoder.** Claude Code / Codex / Qoder use their own `mcp add` CLI (Qoder's
  has no `mcp get`, so idempotency is a `list | grep` check rather than
  register_host's get-then-compare). Cursor, VS Code and Windsurf have no
  registration CLI, so the installer merges one entry into their own dedicated
  MCP config file (`~/.cursor/mcp.json`, the platform `Code/User/mcp.json`,
  `~/.codeium/windsurf/mcp_config.json`) via a real `node`-based JSON
  parse-merge-write (no new dependency) — every other key and every other
  server in the file is left untouched, and a file that fails to parse is left
  alone with a warning rather than risk being overwritten. `--uninstall`
  removes only the `agent-handoff` entry from each. VS Code gets no forced
  `AHP_WORKER_ID` — a Copilot Chat session's model varies, unlike a
  single-purpose agent CLI. New canonical worker ids: `windsurf`, `qoder`,
  `vscode` (folds `copilot` too).
- **Finds Claude Code / Codex on a fresh machine.** Both install their CLI into
  `~/.local/bin` — the dir the installer links `ahp` into and had just reported
  *not on PATH*. Detection ran against the unmodified `PATH` and silently
  downgraded to the copy-paste MCP fallback. The installer now adopts `$BIN_DIR`
  into its own `PATH` for the run while still reporting what the user's shell
  will see.
- **Runs clean on a stock macOS shell (`/bin/bash` 3.2).** The numbered-menu
  fallback opened `/dev/tty` before redirecting stderr (leaked `/dev/tty: Device
  not configured` on a machine with no controlling terminal); the arrow-key menu
  used `read -t 0.1`, a fractional timeout 3.2 rejects. Fixed, and
  `CONTRIBUTING.md` documents the 3.2 contract.
- **Never clobbers an `ahp` it does not own.** A real file, a directory, or a
  symlink to a non-AHP target is left with a message; a symlink into another AHP
  checkout is still re-pointed; the "ahp runs" self-test only fires when this
  checkout was linked; `--uninstall` removes only its own symlinks.
- No longer appends a duplicate `export PATH=…` line on re-run before a new
  shell is opened.
- `ahp dashboard` is documented at every entry point (installer hint, skill,
  Codex `AGENTS.md`, generic-agent prompt, `docs/adoption.md`), not just the
  READMEs. Preflight Node floor 18 → 20 to match `engines` / the ESM bins.

### Docs

- The skill and the integration snippets now say what belongs in the worklog
  (this session's landmines / next / findings) versus the project's own docs
  (anything that outlives the session) — with a two-question test.
- **Privacy pass.** Confirmed zero egress: no telemetry, no remote store, no
  `git fetch`/`push`/`ls-remote`; all subprocess calls are local git or `ps`.
  SPEC §11 now spells out that free-text fields are never auto-populated, that
  the registry (`projects.json`) holds absolute paths and remote URLs and stays
  on the machine, and that worker detection reads ancestor process command lines
  but never stores or transmits them.

### Internal

- `npm test` pins the hand-written `validateRecords` to the JSON schema
  (required fields, closed enums) and asserts no `src/` module imports a network
  primitive — no new dependency.

### Deferred

- **Networked server** (design in [`docs/networked-server.md`](docs/networked-server.md))
  — a hub sharing one worklog per project across devices. Shelved: coding agents
  now have their own remote-control paths, and keeping AHP co-located with the
  repo it tracks (local file, no network dependency for `pickup`) is the simpler
  fit. The design note is kept; the idempotency-key and cross-device contention
  work it implies is out of scope until the scenario is decided.

## 0.3.0 — 2026-08-28

First stable release. The protocol is storage-location-agnostic; the reference
implementation is a real CLI plus an MCP server, a one-command installer, a
cross-project dashboard, and zero-config worker attribution. Node ≥ 20.

### Added

- **`ahp` CLI** (zero runtime dependencies) — `dashboard`, `status`, `pickup`,
  `start`, `intent open|promote`, `end`, `read`, `log`, `verify`, `project`,
  `compact`, `path`. Assigns `seq` / `at` and captures Git state
  (`base.commit`, tree cleanliness) so a worker only supplies the semantic
  content.
- **`ahp dashboard`** — cross-project overview, runnable from anywhere (not
  inside a repo). Per project: baton holder + plan, worklog counts, open
  intents, `verify` status, git HEAD/branch/tree, and a drift check
  (commits since the baton base with no `intent.promote`). `--json` for
  scripting; exit 1 if any project has an error or drift. `-w`/`--watch`
  turns it into a live view (alternate screen, `-n`/`--interval` seconds,
  ctrl-c to exit, reflows on resize).
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
- **Node ≥ 20** — `bin/ahp` / `bin/ahp-mcp` are extensionless ESM entry points,
  which Node < 20 cannot load under `"type":"module"`. Node 18 is end-of-life.

### Fixed

- **Sandboxed runtimes** — `src/git.mjs` trusted `spawnSync().error` over a
  concrete exit status. Some agent execution sandboxes attach an EPERM `.error`
  to a git call that actually succeeded (real stdout, status 0), which made AHP
  wrongly report "not a Git repository". It now only treats `.error` as fatal
  when there is no exit status at all.
- **Worker attribution** — records are no longer left as `unknown`:
  - the CLI walks up the process tree and, if an ancestor is a known agent host
    (Codex, Claude Code, Cursor, Aider, …), uses that as the identity — zero
    config, works whether the agent calls `ahp` directly or through the MCP
    server;
  - the MCP server also takes a default from the host's `initialize`
    `clientInfo.name`;
  - `install.sh` registers the MCP server with `AHP_WORKER_ID` / `AHP_MODEL` /
    `AHP_RUNTIME` in its env.
  - Explicit `--worker-id` and the `AHP_*` env vars still win over all of it.
    A session that started as `unknown` no longer propagates `unknown` to its
    later records.
- **`install.sh` re-run is now a clean sync** — the Codex `AGENTS.md` snippet is
  refreshed in place (was "append once, never update"); the MCP registration is
  verified to still point at this repo and carry the identity env, and
  re-registered only if it drifted (never a blind remove+add). So updating is
  `git pull` + re-run `install.sh` + restart the host — no manual
  `mcp remove`/`add`.

## 0.1.0 — 2026-08-27

Initial public draft: `SPEC.md`, JSON Schema, zero-dep file validator, examples,
integration snippets, bilingual README.
