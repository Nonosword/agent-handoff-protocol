#!/usr/bin/env bash
# Agent Handoff Protocol — installer.
#
#   ./install.sh                 interactive (arrow keys)
#   ./install.sh --mode skill    CLI + Claude Code skill + Codex AGENTS.md snippet
#   ./install.sh --mode mcp      CLI + MCP server registered with detected hosts
#   ./install.sh --uninstall     remove what this installed (the store is kept)
#   ./install.sh --dry-run       show every action, change nothing
#   ./install.sh --no-color      plain output

set -u

# ---------------------------------------------------------------- config ----
REPO="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${AHP_BIN_DIR:-$HOME/.local/bin}"
STORE="${AHP_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-handoff}"
CLAUDE_SKILL_DIR="$HOME/.claude/skills/agent-handoff-protocol"
CODEX_AGENTS="$HOME/.codex/AGENTS.md"
MARK_BEGIN="<!-- BEGIN agent-handoff-protocol -->"
MARK_END="<!-- END agent-handoff-protocol -->"

MODE=""; DRY=0; UNINSTALL=0; USE_COLOR=1; FAILED=0
VERSION="$(node -e 'process.stdout.write(require("'"$REPO"'/package.json").version)' 2>/dev/null || echo "?")"

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --no-color) USE_COLOR=0; shift ;;
    -h|--help) sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1"; exit 2 ;;
  esac
done

[ -t 1 ] || USE_COLOR=0
[ -n "${NO_COLOR:-}" ] && USE_COLOR=0

if [ "$USE_COLOR" = 1 ]; then
  A=$'\033[38;5;39m'; OKC=$'\033[32m'; ERRC=$'\033[31m'; WRNC=$'\033[33m'
  DIM=$'\033[2m'; B=$'\033[1m'; R=$'\033[0m'
else
  A=""; OKC=""; ERRC=""; WRNC=""; DIM=""; B=""; R=""
fi

# ---------------------------------------------------------------- ui -------
line() {
  if [ -n "${4:-}" ]; then printf '  %s%s%s %-30s %s%s%s\n' "$2" "$1" "$R" "$3" "$DIM" "$4" "$R"
  else printf '  %s%s%s %s\n' "$2" "$1" "$R" "$3"; fi
}
ok()      { line "✓" "$OKC" "$1" "${2:-}"; }
skip()    { line "·" "$DIM" "$1" "${2:-}"; }
warn()    { line "!" "$WRNC" "$1" "${2:-}"; }
bad()     { line "✗" "$ERRC" "$1" "${2:-}"; FAILED=1; }
dry()     { line "→" "$A" "$1" "${2:+$2  }·  would"; }
section() { printf '\n%s%s▸%s %s%s\n' "$A" "$B" "$R" "$B" "$1$R"; }
note()    { printf '    %s%s%s\n' "$DIM" "$1" "$R"; }

banner() {
  printf '\n  %s%s  Agent Handoff Protocol%s  %s· installer · v%s%s\n' "$A" "$B" "$R" "$DIM" "$VERSION" "$R"
  printf '  %s%s─────────────────────────────────────────────%s\n' "$A" "$DIM" "$R"
  printf '    %srepo%s   %s\n' "$DIM" "$R" "$REPO"
  printf '    %sbin%s    %s\n' "$DIM" "$R" "$BIN_DIR"
  printf '    %sstore%s  %s\n' "$DIM" "$R" "$STORE"
}

# arrow-key menu -> $MENU_CHOICE (0-based). Falls back to a numbered prompt.
menu() {
  local title="$1"; shift
  local opts=("$@") n=${#opts[@]} sel=0 key
  printf '\n%s%s%s\n' "$B" "$title" "$R"
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    local i=1
    for o in "${opts[@]}"; do printf '  %d) %s\n' "$i" "${o%%|*}"; i=$((i+1)); done
    printf 'choose [1-%d]: ' "$n"
    read -r sel </dev/tty 2>/dev/null || sel=1
    case "$sel" in ''|*[!0-9]*) sel=1 ;; esac
    [ "$sel" -ge 1 ] && [ "$sel" -le "$n" ] || sel=1
    MENU_CHOICE=$((sel - 1))
    return
  fi
  _render() {
    local i
    for i in $(seq 0 $((n-1))); do
      local L="${opts[$i]%%|*}" D="${opts[$i]#*|}"
      if [ "$i" -eq "$sel" ]; then
        printf '  %s%s❯ %-6s%s %s%s%s\n' "$A" "$B" "$L" "$R" "$DIM" "$D" "$R"
      else
        printf '    %-6s %s%s%s\n' "$L" "$DIM" "$D" "$R"
      fi
    done
  }
  printf '%s' $'\033[?25l'
  _render
  while true; do
    IFS= read -rsn1 key </dev/tty
    case "$key" in
      $'\033') read -rsn2 -t 0.1 key </dev/tty
               case "$key" in '[A') sel=$(((sel-1+n)%n));; '[B') sel=$(((sel+1)%n));; esac ;;
      k) sel=$(((sel-1+n)%n)) ;;
      j) sel=$(((sel+1)%n)) ;;
      [1-9]) [ "$key" -le "$n" ] && { sel=$((key-1)); break; } ;;
      "") break ;;
    esac
    printf '\033[%dA' "$n"; _render
  done
  printf '%s' $'\033[?25h'
  MENU_CHOICE=$sel
}

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" = 1 ]; then
  banner
  section "Uninstall"
  for b in ahp ahp-mcp; do
    if [ -L "$BIN_DIR/$b" ] || [ -e "$BIN_DIR/$b" ]; then
      [ "$DRY" = 1 ] && dry "remove command" "$BIN_DIR/$b" || { rm -f "$BIN_DIR/$b"; ok "removed command" "$BIN_DIR/$b"; }
    else skip "command not installed" "$b"; fi
  done
  if [ -d "$CLAUDE_SKILL_DIR" ]; then
    [ "$DRY" = 1 ] && dry "remove Claude skill" "$CLAUDE_SKILL_DIR" || { rm -rf "$CLAUDE_SKILL_DIR"; ok "removed Claude skill" "$CLAUDE_SKILL_DIR"; }
  else skip "Claude skill not present"; fi
  if [ -f "$CODEX_AGENTS" ] && grep -qF "$MARK_BEGIN" "$CODEX_AGENTS"; then
    if [ "$DRY" = 1 ]; then dry "strip Codex AGENTS.md block" "$CODEX_AGENTS"
    else
      awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0==b{s=1} !s{print} $0==e{s=0}' "$CODEX_AGENTS" > "$CODEX_AGENTS.ahptmp" && mv "$CODEX_AGENTS.ahptmp" "$CODEX_AGENTS"
      ok "stripped Codex AGENTS.md block" "$CODEX_AGENTS"
    fi
  else skip "Codex snippet not present"; fi
  if command -v claude >/dev/null 2>&1; then
    [ "$DRY" = 1 ] && dry "remove MCP registration" "claude mcp remove agent-handoff" || { claude mcp remove agent-handoff >/dev/null 2>&1 && ok "removed MCP registration" "claude" || skip "no MCP registration in claude"; }
  fi
  printf '\n  %sThe store at %s was left intact.%s\n\n' "$DIM" "$STORE" "$R"
  exit 0
fi

# ---------------------------------------------------------------- install
banner

section "Preflight"
if command -v node >/dev/null 2>&1; then
  NV="$(node -p 'process.versions.node')"
  MAJ="${NV%%.*}"
  if [ "$MAJ" -ge 18 ] 2>/dev/null; then ok "Node.js" "v$NV"; else bad "Node.js too old" "v$NV (need >= 18.17)"; fi
else bad "Node.js not found" "install Node >= 18.17"; fi
command -v git >/dev/null 2>&1 && ok "Git" "$(git --version | awk '{print $3}')" || bad "Git not found"
[ "$FAILED" = 1 ] && { printf '\n  %sfix the above and re-run.%s\n\n' "$ERRC" "$R"; exit 1; }

section "Command line"
if [ "$DRY" = 1 ]; then
  dry "symlink ahp" "$BIN_DIR/ahp"
  dry "symlink ahp-mcp" "$BIN_DIR/ahp-mcp"
else
  mkdir -p "$BIN_DIR"
  ln -sf "$REPO/bin/ahp" "$BIN_DIR/ahp";       ok "linked ahp" "$BIN_DIR/ahp"
  ln -sf "$REPO/bin/ahp-mcp" "$BIN_DIR/ahp-mcp"; ok "linked ahp-mcp" "$BIN_DIR/ahp-mcp"
  if "$BIN_DIR/ahp" --version >/dev/null 2>&1; then ok "ahp runs" "$("$BIN_DIR/ahp" --version)"; else bad "ahp failed to run"; fi
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) [ "$DRY" = 1 ] || ok "on PATH" "$BIN_DIR" ;;
  *)
    warn "not on PATH" "$BIN_DIR"
    RC=""; case "${SHELL##*/}" in zsh) RC="$HOME/.zshrc" ;; bash) RC="$HOME/.bashrc" ;; esac
    if [ -n "$RC" ] && [ "$DRY" != 1 ] && [ -t 0 ]; then
      printf '    add %sexport PATH="%s:$PATH"%s to %s now? [y/N] ' "$B" "$BIN_DIR" "$R" "$RC"
      read -r yn </dev/tty || yn=n
      case "$yn" in y|Y) printf '\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$RC"; ok "appended to shell rc" "$RC — open a new shell" ;;
                    *) note "later: export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
    else
      note "add to your shell rc: export PATH=\"$BIN_DIR:\$PATH\""
    fi ;;
esac

section "Store"
if [ "$DRY" = 1 ]; then
  dry "create store" "$STORE"
else
  if [ -d "$STORE" ]; then skip "store exists" "$STORE"; else mkdir -p "$STORE" && ok "created store" "$STORE"; fi
  if ( : > "$STORE/.probe" ) 2>/dev/null; then rm -f "$STORE/.probe"; ok "store is writable"; else bad "store not writable" "$STORE"; fi
  PROJN=0; [ -f "$STORE/projects.json" ] && PROJN="$(node -e 'try{process.stdout.write(String(Object.keys(require("'"$STORE"'/projects.json").projects||{}).length))}catch{process.stdout.write("0")}' 2>/dev/null || echo 0)"
  skip "registered projects" "$PROJN"
fi

section "Agent hosts"
HAS_CLAUDE=0; command -v claude >/dev/null 2>&1 && HAS_CLAUDE=1
HAS_CODEX=0;  command -v codex  >/dev/null 2>&1 && HAS_CODEX=1
[ "$HAS_CLAUDE" = 1 ] && ok "claude" "$(claude --version 2>/dev/null | head -1)" || skip "claude" "not found"
[ "$HAS_CODEX" = 1 ]  && ok "codex"  "$(codex --version 2>/dev/null | head -1)"  || skip "codex" "not found"

if [ -z "$MODE" ]; then
  menu "How should your agents reach ahp?" \
    "skill|Claude Code skill + Codex AGENTS.md snippet — the agent runs the ahp CLI" \
    "mcp|run ahp-mcp as an MCP server — the agent calls tools directly"
  case "$MENU_CHOICE" in 1) MODE=mcp ;; *) MODE=skill ;; esac
fi
printf '  %smode%s  %s%s%s\n' "$DIM" "$R" "$B" "$MODE" "$R"

# ---- skill mode ----------------------------------------------------------
install_skill() {
  section "Skill deployment"
  if [ "$HAS_CLAUDE" = 1 ] || [ -d "$HOME/.claude" ]; then
    if [ "$DRY" = 1 ]; then dry "install Claude Code skill" "$CLAUDE_SKILL_DIR"
    else
      mkdir -p "$(dirname "$CLAUDE_SKILL_DIR")"
      rm -rf "$CLAUDE_SKILL_DIR"
      cp -R "$REPO/skills/claude-code/agent-handoff-protocol" "$CLAUDE_SKILL_DIR"
      if [ -f "$CLAUDE_SKILL_DIR/SKILL.md" ]; then
        ok "Claude Code skill" "$CLAUDE_SKILL_DIR"
        note "$(grep -c . "$CLAUDE_SKILL_DIR/SKILL.md") lines · trigger: \"handoff\", \"pick up\", \"resume\""
      else bad "skill copy failed" "$CLAUDE_SKILL_DIR"; fi
    fi
  else skip "Claude Code" "no ~/.claude — skipped"; fi

  if [ "$HAS_CODEX" = 1 ] || [ -d "$HOME/.codex" ]; then
    if [ "$DRY" = 1 ]; then dry "append Codex AGENTS.md snippet" "$CODEX_AGENTS"
    elif [ -f "$CODEX_AGENTS" ] && grep -qF "$MARK_BEGIN" "$CODEX_AGENTS"; then
      skip "Codex AGENTS.md snippet" "already present"
    else
      mkdir -p "$(dirname "$CODEX_AGENTS")"
      { printf '\n%s\n' "$MARK_BEGIN"
        sed -n '/^```markdown$/,/^```$/p' "$REPO/integrations/codex-AGENTS.md" | sed '1d;$d'
        printf '%s\n' "$MARK_END"
      } >> "$CODEX_AGENTS"
      grep -qF "$MARK_BEGIN" "$CODEX_AGENTS" && ok "Codex AGENTS.md snippet" "$CODEX_AGENTS" || bad "AGENTS.md append failed"
    fi
  else skip "Codex" "no ~/.codex — skipped"; fi
}

# ---- mcp mode ----------------------------------------------------------
install_mcp() {
  section "MCP server"
  if [ "$DRY" = 1 ]; then
    dry "register with Claude Code" "claude mcp add agent-handoff -- node $REPO/bin/ahp-mcp"
  elif [ "$HAS_CLAUDE" = 1 ]; then
    if claude mcp add agent-handoff -- node "$REPO/bin/ahp-mcp" >/dev/null 2>&1; then
      ok "registered with Claude Code" "restart Claude Code to load it"
      if claude mcp get agent-handoff >/dev/null 2>&1; then ok "MCP entry confirmed" "claude mcp get agent-handoff"; fi
    elif claude mcp get agent-handoff >/dev/null 2>&1; then
      skip "Claude Code MCP entry" "already registered"
    else bad "claude mcp add failed" "add it by hand — see integrations/mcp.md"; fi
  else
    warn "Claude Code CLI" "not found — add to ~/.claude.json:"
    note '{ "mcpServers": { "agent-handoff": { "command": "node", "args": ["'"$REPO"'/bin/ahp-mcp"] } } }'
  fi

  if [ "$HAS_CODEX" = 1 ] || [ -d "$HOME/.codex" ]; then
    note "Codex — add to ~/.codex/config.toml:"
    note "  [mcp_servers.agent-handoff]"
    note "  command = \"node\""
    note "  args = [\"$REPO/bin/ahp-mcp\"]"
  fi

  if [ "$DRY" != 1 ]; then
    if printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
      | node "$REPO/bin/ahp-mcp" 2>/dev/null | grep -q '"serverInfo"'; then
      ok "MCP server self-test" "initialize handshake OK"
    else bad "MCP server self-test failed"; fi
  fi
  note "tools: ahp_status ahp_pickup ahp_start ahp_intent_open ahp_intent_promote ahp_end ahp_read ahp_verify"
}

case "$MODE" in
  skill) install_skill ;;
  mcp)   install_mcp ;;
  *) printf '\n  %sunknown --mode: %s (skill | mcp)%s\n\n' "$ERRC" "$MODE" "$R"; exit 2 ;;
esac

# ---- self-test + summary ---------------------------------------------
if [ "$DRY" != 1 ]; then
  section "Self-test"
  command -v ahp >/dev/null 2>&1 && ok "ahp resolves on PATH" "$(command -v ahp)" || warn "ahp not on PATH yet" "open a new shell"
  "$BIN_DIR/ahp" --version >/dev/null 2>&1 && ok "ahp --version" "$("$BIN_DIR/ahp" --version)" || bad "ahp --version failed"
fi

section "Done"
if [ "$FAILED" = 1 ]; then
  printf '  %s%s✗ finished with errors%s — see the ✗ lines above.\n\n' "$ERRC" "$B" "$R"
  exit 1
fi
printf '  %s%s✓ installed%s  (mode: %s%s%s)\n\n' "$OKC" "$B" "$R" "$B" "$MODE" "$R"
printf '  Try it:\n'
printf '    %scd <a git repo>%s\n' "$DIM" "$R"
printf '    %sahp status%s        %s# where things stand%s\n' "$B" "$R" "$DIM" "$R"
printf '    %sahp pickup%s        %s# before you start work%s\n' "$B" "$R" "$DIM" "$R"
printf '\n  Docs: %s/SPEC.md · %s/docs/adoption.md\n\n' "$REPO" "$REPO"
