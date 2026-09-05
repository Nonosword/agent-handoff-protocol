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
`ahp_intent_promote`, `ahp_end`, `ahp_read`, `ahp_verify`.

## Any MCP host

Command: `node <REPO>/bin/ahp-mcp` · transport: stdio · protocol: `2025-06-18`.

Each tool takes an optional `cwd` (directory to resolve the project from —
default: the host's working directory) and `project` (explicit id/name).

## Tools

| tool | purpose |
| --- | --- |
| `ahp_status` | project, baton holder, open intents, tree/gate state |
| `ahp_pickup` | guided pickup — read before taking the baton |
| `ahp_start` | append `handoff.start` (needs `plan`, `gate`) |
| `ahp_intent_open` | declare a unit of work |
| `ahp_intent_promote` | record its commit landed (`actual` / `landmines` / `next`) |
| `ahp_end` | append `handoff.end` (best-effort) |
| `ahp_read` | read records, or project one field (`field:"hazards"` = landmines + findings) |
| `ahp_verify` | validate the worklog |

## Agent instruction

Whichever host: add a line to the agent's rules — *"At session start call
`ahp_pickup`, reconcile, then `ahp_start`. One `ahp_intent_open` /
`ahp_intent_promote` per commit. `ahp_end` when stopping."*
