# MCP server

`ahp-mcp` speaks the Model Context Protocol over stdio (zero dependencies). It
exposes the worklog as tools so an agent calls them directly instead of shelling
out — the free-text fields go as structured strings, not through shell quoting.
The skill / `AGENTS.md` snippet tell agents to prefer these tools when present.

`install.sh --mode mcp` registers this automatically with each host it detects.
Claude Code, Codex and Qoder have their own MCP CLI:

```sh
claude mcp add agent-handoff -- node <REPO>/bin/ahp-mcp
codex  mcp add agent-handoff -- node <REPO>/bin/ahp-mcp
qoder  mcp add agent-handoff -s user -- node <REPO>/bin/ahp-mcp
```

All idempotent and edit the host's config safely; `<REPO>` is the absolute path
to your clone. Restart the host to load the server. Remove with
`<host> mcp remove agent-handoff`.

Cursor, VS Code and Windsurf have no registration CLI, so the installer merges
one entry into their dedicated MCP config file directly (a real JSON
parse-merge-write — nothing else in the file is touched; a file the installer
cannot parse is left alone with a warning, never overwritten). `--uninstall`
removes only that entry.

## By hand

**Claude Code** — `~/.claude.json` (global) or a project `.mcp.json`:

```json
{ "mcpServers": { "agent-handoff": { "command": "node", "args": ["<REPO>/bin/ahp-mcp"] } } }
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.agent-handoff]
command = "node"
args = ["<REPO>/bin/ahp-mcp"]
```

**Cursor** — `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "agent-handoff": { "command": "node", "args": ["<REPO>/bin/ahp-mcp"] } } }
```

**VS Code** — user `mcp.json` (Command Palette → *MCP: Open User Configuration*):

```json
{ "servers": { "agent-handoff": { "type": "stdio", "command": "node", "args": ["<REPO>/bin/ahp-mcp"] } } }
```

**Windsurf** — `~/.codeium/windsurf/mcp_config.json`:

```json
{ "mcpServers": { "agent-handoff": { "command": "node", "args": ["<REPO>/bin/ahp-mcp"] } } }
```

**Qoder** — CLI (`qoder mcp add agent-handoff -s user -- node <REPO>/bin/ahp-mcp`)
or project `.mcp.json` in the same shape as Cursor's, above.

The tools appear as `ahp_status`, `ahp_pickup`, `ahp_start`, `ahp_intent_open`,
`ahp_intent_promote`, `ahp_end`, `ahp_read`, `ahp_verify`, plus
`ahp_lane_list`, `ahp_lane_create`, and `ahp_lane_edit`.

## Any MCP host

Command: `node <REPO>/bin/ahp-mcp` · transport: stdio · protocol: `2025-06-18`.

Worklog tools take optional `cwd` and `project` fields to resolve the Project,
plus `lane` to select its work stream. Carry the same `lane` through pickup,
start and writes; omit it only when no ambiguity exists.
Lane-management tools resolve the Project from `cwd` / `project` directly.

## Tools

| tool | purpose |
| --- | --- |
| `ahp_status` | project, baton holder, open intents, tree/gate state |
| `ahp_pickup` | compact guided pickup; `full:true` expands all detail |
| `ahp_start` | append `handoff.start` (needs `plan`, `gate`) |
| `ahp_intent_open` | declare a unit of work |
| `ahp_intent_promote` | record its commit landed (`actual` / `landmines` / `next`) |
| `ahp_end` | append `handoff.end` (best-effort) |
| `ahp_read` | read records, or project one field (`field:"hazards"` = landmines + findings) |
| `ahp_verify` | validate the selected Lane worklog |
| `ahp_lane_list` | list Lane descriptions and baton state |
| `ahp_lane_create` | create a Lane only when no existing one matches |
| `ahp_lane_edit` | refine Lane metadata or lifecycle status |

## Agent instruction

Whichever host: tell the agent to resolve the Project and Lane first. It should
select a clear Lane match itself, create one only when none matches, and ask the
operator only for genuine ambiguity. Then call `ahp_pickup`, reconcile, and
`ahp_start`; use one intent per commit and `ahp_end` when stopping.
