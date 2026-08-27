# Networked server — design (planned, not yet implemented)

**Status:** design · **Target:** 0.4.0

Today `ahp-mcp` is stdio-only: the MCP host spawns it as a local subprocess, and
the worklog store lives on that same machine. Two machines working the same
project (same Git remote) keep two separate worklogs.

This document plans a shared deployment: several devices, agents on any of them,
**one worklog per project, one writer**.

## Approach

Run **one `ahp-mcp` in HTTP mode on a hub machine**. MCP hosts on any device
connect to it over the network. Every write funnels through the one process, so
the single-writer invariant (append-only, strictly increasing `seq`, SPEC §4.2)
holds without cross-machine file locking.

```
  device A ─ codex ─┐
  device B ─ claude ┼── HTTP ──▶  ahp-mcp --serve   ──▶  $AHP_HOME (hub)
  device C ─ cursor ┘             (hub machine)          one file per project
```

The project ships a **service entry point and a config file**. Where the
listener is reachable from — loopback, a LAN address, a Tailscale/WireGuard
address, a unix socket behind a reverse proxy — is entirely the operator's
choice. AHP does not assume Tailscale or any particular network.

## Transport

MCP [Streamable HTTP transport](https://modelcontextprotocol.io/) (POST for
requests, GET for the SSE event stream, `Mcp-Session-Id` header). Still
zero-dependency — Node's `node:http` plus a hand-written SSE writer.

```
ahp-mcp --serve [--config <path>]
```

## Configuration

`$AHP_HOME/server.json` (created by `install.sh --server` or `ahp serve --init`):

```json
{
  "listen": "127.0.0.1:8787",
  "store":  "~/.local/share/agent-handoff",
  "auth":   { "mode": "none" },
  "allowOrigins": [],
  "tls":    { "mode": "none" }
}
```

- **`listen`** — `host:port`, `[::1]:port`, or `unix:/path/to.sock`. The
  operator picks the interface; AHP just binds it. `install.sh --server` prints
  the reminder to open the port / expose it however the operator wants.
- **`auth.mode`**:
  - `none` — trust the network (a LAN segment, a private tunnel).
  - `token` — a shared secret; the client sends `Authorization: Bearer <token>`.
    Secret from `auth.tokenFile` or `$AHP_SERVER_TOKEN`.
  - `header` — trust an identity header set by an upstream proxy / tunnel
    (`auth.headerName`, e.g. a reverse proxy's authenticated-user header). The
    value becomes part of the recorded `worker` when the client doesn't override.
- **`tls`** — `none` (plain HTTP; fine behind a tunnel or proxy that terminates
  TLS), or `{ "cert": "...", "key": "..." }` for direct HTTPS.
- **`allowOrigins`** — CORS allow-list for browser-based MCP clients; empty by
  default.

Nothing here is network-vendor-specific. A Tailscale user sets
`listen` to their tailnet address (or runs `tailscale serve` in front and keeps
`listen` on loopback); a LAN user sets a LAN address and opens a firewall port;
a single-box user keeps loopback. The installer does not do any of that for
them — it writes the config, starts the listener, and tells them what to expose.

## Git facts: the agent supplies them, guided by the response

Some tools need to read the project's Git checkout — `git rev-parse HEAD`,
`git status`, `git log base..HEAD`. That checkout lives on the agent's machine,
not the hub. In single-machine stdio mode the server does these reads itself
(unchanged). Over the network **the agent supplies the facts as tool
parameters**, and the response tells it exactly what's missing.

We deliberately keep the client thin — no local proxy process, no extra daemon.
The cost is a few short git commands the agent runs; the design makes that
frictionless by never sending the agent back to the docs.

### Which tools need what

| tool | git params | hub already knows |
| --- | --- | --- |
| `ahp_status` | `head`, `branch`, `tree_clean` | — |
| `ahp_pickup` | `head`, `commits_since` (`git log --format='%h %s' <base>..HEAD`) | `<base>` (from the worklog) |
| `ahp_start` | `head` → `base.commit`, `tree_clean` | — |
| `ahp_end` | `head` → `end.commit`, `tree_clean` | — |
| `ahp_intent_open` / `ahp_intent_promote` | none (`commits` is already a param) | — |

Also `project` — the normalized `origin` remote URL
(`git remote get-url origin`), the same on every clone. The agent passes it once
per session; the hub keys the worklog by it and never needs a filesystem path.

### Guided responses

A call that is missing a required fact does **not** fail silently or with a
generic error. It returns an actionable instruction the agent can execute and
retry, e.g.:

```
ahp_start(plan="…", gate="pass")
→ isError: true
  "Missing git facts for a networked call. Run these in the project and retry:
     head        = git rev-parse HEAD
     tree_clean  = test -z \"$(git status --porcelain)\" && echo true || echo false
   Also pass  project = git remote get-url origin  (once per session)."
```

```
ahp_pickup(project="github.com/acme/api")
→ isError: true
  "Provide the commits since the last handoff base 4f2a1c0 so the reconcile
   check can run:
     commits_since = git log --format='%h %s' 4f2a1c0..HEAD
     head          = git rev-parse HEAD"
```

The agent reads the response, runs the commands, retries. No doc lookup, no
guessing. The same messages are useful in stdio mode too if the local git read
fails (sandbox, detached worktree).

### Stdio mode is unaffected

When `ahp-mcp` runs locally (stdio), missing git params are filled by reading
the local checkout, exactly as today. The parameters are optional there;
required (with the guided response) only for a networked hub.

## Project identity across machines

Unchanged in principle (SPEC §4.4): the key is the normalized `origin` remote
URL, which is the same on every clone. The agent resolves it locally
(`git remote get-url origin`) and passes it as `project`; the hub never needs to
see a filesystem path.

## Baton across devices

With genuine multi-device concurrency, a second `handoff.start` while one is
active for a project is contention, not a cutoff. The hub server MUST reject it
(`409`-style error the agent sees) unless `--force` is passed, and a forced
start records whom it displaced. This is a small SPEC §7/§8 amendment that lands
with this feature.

## Store ownership & backup

The hub owns `$AHP_HOME`. It MAY be a Git repository the hub auto-commits and
pushes (backup + audit history) — independent of the transport. A hub outage
means no recording anywhere until it restarts; the store is plain files, so
restore is a file copy.

## Dashboard

`ahp dashboard` gains `--server <url>` (or reads it from `server.json`): the hub
exposes a read-only JSON projection over HTTP and the dashboard renders it, so
`ahp dashboard -w` works from any device.

## Offline

A client that cannot reach the hub cannot record. v1 documents this. A future
local write-ahead queue with replay-on-reconnect is out of scope here (and would
reintroduce ordering questions the single-writer model avoids).

## Non-goals

- Not a multi-master / CRDT store. One writer, one `seq` sequence.
- Not a hosted service. AHP ships the server and simple auth hooks; running it,
  exposing it, and securing the network are the operator's.
- No built-in coupling to any VPN / tunnel / mesh product.

## Decided

- **The client stays thin.** No local proxy. The agent passes git facts as tool
  params; the hub's response says exactly which command to run for anything
  missing.

## Open questions

- Config format — JSON (matches the schema tooling) vs TOML (matches Codex's
  own config).
- Whether `ahp` (CLI) also learns `--server` so a person on a laptop can
  `ahp dashboard` / `ahp read` against the hub without an MCP host.
- systemd unit vs a plain `ahp serve` the operator supervises however they like.
- `commits_since` transport: a newline-joined `git log` string, or a structured
  array — and whether the hub ever needs more than short-sha + subject.
