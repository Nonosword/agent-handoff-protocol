# MCP server

`ahp-mcp` speaks the Model Context Protocol over stdio (zero dependencies). It
exposes the worklog as tools so an agent calls them directly instead of shelling
out — the free-text fields go as structured strings, not through shell quoting.
The skill / `AGENTS.md` snippet tell agents to prefer these tools when present.

`install.sh --mode mcp` registers this automatically with each host it detects.
**Qoder** and **Qoder CN are separate products**: detection reports each one
independently and never folds CN into the Qoder result.

```sh
# Qoder: its global CLI supports MCP subcommands.
qoder mcp add agent-handoff -s user -- node <REPO>/bin/ahp-mcp

# Qoder CN: its app CLI accepts a server-definition JSON, not `mcp add`.
qoder-cn --add-mcp '{"name":"agent-handoff","command":"node","args":["<REPO>/bin/ahp-mcp"]}'
```

The installer invokes only a detected host's matching CLI: Qoder's `mcp
add/list/remove` interface, or Qoder CN's `--add-mcp <JSON>` interface. It
locates CN from `qoder-cn` on PATH or
`/Applications/Qoder CN IDE.app/Contents/Resources/app/bin/qoder-cn`, and
checks the independent `~/.qoder-cn/mcp.json`; it never calls `qoder mcp` for
CN. Restart the host after registration. Qoder CN exposes no remove CLI, so
`--uninstall` safely removes only AHP's entry from its dedicated MCP JSON.

Claude Desktop, Cursor, VS Code and Windsurf have no registration CLI, so the
installer merges one entry into their dedicated MCP config file directly (a real JSON
parse-merge-write — nothing else in the file is touched; a file the installer
cannot parse is left alone with a warning, never overwritten). `--uninstall`
removes only that entry.

## By hand

**Claude Code** — `~/.claude.json` (global) or a project `.mcp.json`:

```json
{ "mcpServers": { "agent-handoff": { "command": "node", "args": ["<REPO>/bin/ahp-mcp"] } } }
```

**Claude Desktop (macOS)** —
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{ "mcpServers": { "agent-handoff": { "command": "node", "args": ["<REPO>/bin/ahp-mcp"] } } }
```

Claude Desktop and Claude Code are separate hosts. Configure either one without
requiring the other; quit and reopen Claude Desktop after changing its config.

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

**Qoder CN** — its own app CLI, not a Qoder alias:

```sh
qoder-cn --add-mcp '{"name":"agent-handoff","command":"node","args":["<REPO>/bin/ahp-mcp"]}'
```

On macOS the bundled CLI is normally
`/Applications/Qoder CN IDE.app/Contents/Resources/app/bin/qoder-cn`; its user
MCP config is `~/.qoder-cn/mcp.json`.

The tools appear as `ahp_status`, `ahp_pickup`, `ahp_start`, `ahp_intent_open`,
`ahp_intent_promote`, `ahp_end`, `ahp_read`, `ahp_verify`, plus
`ahp_lane_list`, `ahp_lane_create`, and `ahp_lane_edit`.

## Any MCP host

Command: `node <REPO>/bin/ahp-mcp` · transport: stdio · protocol: `2025-06-18`.

Worklog tools take optional `cwd` and `project` fields to resolve the Project,
plus `lane` to select its work stream. Carry the same `lane` through pickup,
start and writes; omit it only when no ambiguity exists.
Lane-management tools resolve the Project from `cwd` / `project` directly.

For **Claude Desktop**, pass an absolute `cwd` inside the target Git checkout
on every project-scoped MCP call (or use a registered `project` id/name).
Desktop launches its stdio server independently of the chat UI, so the server
cannot infer a repository from the visible conversation. Once the Project has
multiple Lanes, also pass its matching `lane`.

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
