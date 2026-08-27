#!/usr/bin/env bash
# Agent Handoff Protocol — one-command install.
#
#   ./install.sh                 interactive
#   ./install.sh --mode skill    CLI + Claude Code skill + Codex AGENTS.md snippet
#   ./install.sh --mode mcp      CLI + MCP server registered with detected hosts
#   ./install.sh --uninstall     remove what this script installed
#   ./install.sh --dry-run       print actions, change nothing
#
# Always installed: the `ahp` / `ahp-mcp` CLIs (symlinked into a bin dir on PATH)
# and the store directory. The mode only changes how your agents reach it.

set -eu

REPO="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${AHP_BIN_DIR:-$HOME/.local/bin}"
STORE="${AHP_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-handoff}"
MODE=""
DRY=0
UNINSTALL=0

CLAUDE_SKILL_DIR="$HOME/.claude/skills/agent-handoff-protocol"
CODEX_AGENTS="$HOME/.codex/AGENTS.md"
MARK_BEGIN="<!-- BEGIN agent-handoff-protocol -->"
MARK_END="<!-- END agent-handoff-protocol -->"

say()  { printf '%s\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then say "  would: $*"; else eval "$*"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) say "unknown option: $1"; exit 2 ;;
  esac
done

need_node() {
  have node || { say "error: Node.js >= 18.17 is required and 'node' is not on PATH."; exit 1; }
}

# --- uninstall ------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  say "Uninstalling agent-handoff-protocol (the store at $STORE is left intact)"
  run "rm -f '$BIN_DIR/ahp' '$BIN_DIR/ahp-mcp'"
  run "rm -rf '$CLAUDE_SKILL_DIR'"
  if [ -f "$CODEX_AGENTS" ] && grep -qF "$MARK_BEGIN" "$CODEX_AGENTS"; then
    if [ "$DRY" = 1 ]; then
      say "  would: strip the agent-handoff block from $CODEX_AGENTS"
    else
      awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
        $0==b{skip=1} !skip{print} $0==e{skip=0}' "$CODEX_AGENTS" > "$CODEX_AGENTS.ahptmp" \
        && mv "$CODEX_AGENTS.ahptmp" "$CODEX_AGENTS"
      say "  stripped agent-handoff block from $CODEX_AGENTS"
    fi
  fi
  have claude && run "claude mcp remove agent-handoff 2>/dev/null || true"
  say "Done. Re-add MCP entries you edited by hand yourself."
  exit 0
fi

need_node

# --- always: CLI + store -------------------------------------------------
say "agent-handoff-protocol installer"
say "  repo:  $REPO"
say "  bin:   $BIN_DIR"
say "  store: $STORE"
say ""

run "mkdir -p '$BIN_DIR' '$STORE'"
run "ln -sf '$REPO/bin/ahp' '$BIN_DIR/ahp'"
run "ln -sf '$REPO/bin/ahp-mcp' '$BIN_DIR/ahp-mcp'"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) say "NOTE: $BIN_DIR is not on your PATH. Add:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# --- detect hosts ------------------------------------------------------
HAS_CLAUDE=0; have claude && HAS_CLAUDE=1
HAS_CODEX=0;  have codex  && HAS_CODEX=1
say ""
say "Detected agent hosts:  claude=$([ $HAS_CLAUDE = 1 ] && echo yes || echo no)   codex=$([ $HAS_CODEX = 1 ] && echo yes || echo no)"

# --- choose mode -----------------------------------------------------
if [ -z "$MODE" ]; then
  say ""
  say "How should your agents reach ahp?"
  say "  1) skill  — Claude Code skill + Codex AGENTS.md snippet (agent runs the CLI)"
  say "  2) mcp    — run ahp as an MCP server (agent calls tools directly)"
  printf 'choose [1/2]: '
  read -r choice </dev/tty || choice=1
  case "$choice" in 2) MODE=mcp ;; *) MODE=skill ;; esac
fi

install_skill() {
  say ""
  say "== skill mode =="
  if [ "$HAS_CLAUDE" = 1 ] || [ -d "$HOME/.claude" ]; then
    run "mkdir -p '$(dirname "$CLAUDE_SKILL_DIR")'"
    run "rm -rf '$CLAUDE_SKILL_DIR'"
    run "cp -R '$REPO/skills/claude-code/agent-handoff-protocol' '$CLAUDE_SKILL_DIR'"
    say "  Claude Code skill -> $CLAUDE_SKILL_DIR"
  else
    say "  (no ~/.claude — skipping Claude Code skill)"
  fi
  if [ "$HAS_CODEX" = 1 ] || [ -d "$HOME/.codex" ]; then
    run "mkdir -p '$(dirname "$CODEX_AGENTS")'"
    if [ -f "$CODEX_AGENTS" ] && grep -qF "$MARK_BEGIN" "$CODEX_AGENTS" 2>/dev/null; then
      say "  Codex AGENTS.md snippet already present — leaving it"
    else
      if [ "$DRY" = 1 ]; then
        say "  would: append AGENTS.md snippet to $CODEX_AGENTS"
      else
        { printf '\n%s\n' "$MARK_BEGIN"
          sed -n '/^```markdown$/,/^```$/p' "$REPO/integrations/codex-AGENTS.md" | sed '1d;$d'
          printf '%s\n' "$MARK_END"
        } >> "$CODEX_AGENTS"
        say "  Codex AGENTS.md snippet -> $CODEX_AGENTS"
      fi
    fi
  else
    say "  (no ~/.codex — skipping Codex snippet)"
  fi
  say ""
  say "Agents will run \`ahp pickup\` / \`ahp start\` / \`ahp intent ...\` / \`ahp end\`."
}

install_mcp() {
  say ""
  say "== mcp mode =="
  if [ "$HAS_CLAUDE" = 1 ]; then
    run "claude mcp add agent-handoff -- node '$REPO/bin/ahp-mcp'"
    say "  registered with Claude Code (claude mcp add). Restart Claude Code."
  else
    say "  Claude Code CLI not found. Add to ~/.claude.json manually:"
    cat <<EOF
    { "mcpServers": { "agent-handoff": { "command": "node", "args": ["$REPO/bin/ahp-mcp"] } } }
EOF
  fi
  if [ "$HAS_CODEX" = 1 ] || [ -d "$HOME/.codex" ]; then
    say "  Codex: add to ~/.codex/config.toml —"
    cat <<EOF
    [mcp_servers.agent-handoff]
    command = "node"
    args = ["$REPO/bin/ahp-mcp"]
EOF
  fi
  say ""
  say "Any MCP host:  command 'node $REPO/bin/ahp-mcp', stdio transport."
  say "Tools: ahp_status ahp_pickup ahp_start ahp_intent_open ahp_intent_promote ahp_end ahp_read ahp_verify"
  say "Tell the agent: \"call ahp_pickup at session start, then ahp_start; one intent per commit; ahp_end when stopping.\""
}

case "$MODE" in
  skill) install_skill ;;
  mcp)   install_mcp ;;
  *) say "unknown --mode: $MODE (use skill | mcp)"; exit 2 ;;
esac

say ""
say "Done. Try:  cd <a git repo> && ahp status"
