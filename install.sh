#!/usr/bin/env bash
# Agent Handoff Protocol — installer.
#
#   ./install.sh                 interactive (arrow keys)
#   ./install.sh --mode cli      CLI + skill + Codex AGENTS.md snippet
#   ./install.sh --mode mcp      the above, plus the MCP server (recommended)
#   ./install.sh --uninstall     remove what this installed (the store is kept)
#   ./install.sh --dry-run       show every action, change nothing
#   ./install.sh --no-color      plain output
#
# The skill / AGENTS.md snippet (the workflow) are always deployed; the mode
# only decides whether agents also get native ahp_* tools via the MCP server.

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
    -h|--help) sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1"; exit 2 ;;
  esac
done

[ -t 1 ] || USE_COLOR=0
[ -n "${NO_COLOR:-}" ] && USE_COLOR=0

if [ "$USE_COLOR" = 1 ]; then
  # gray is a foreground colour (bright-black), NOT the ESC[2m "dim" attribute —
  # some terminals render "dim" as a translucent dark overlay that reads as a
  # second background layer.
  A=$'\033[38;5;39m'; OKC=$'\033[32m'; ERRC=$'\033[31m'; WRNC=$'\033[33m'
  DIM=$'\033[90m'; B=$'\033[1m'; R=$'\033[0m'
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
hint()    { printf '      %s%s%s\n' "$DIM" "$1" "$R"; }        # gray sub-line under a status
snippet() {                                                    # literal block to read / copy
  printf '\n'
  while IFS= read -r _l; do printf '      %s│%s %s\n' "$A" "$R" "$_l"; done
  printf '\n'
}

banner() {
  printf '\n  %s%s  Agent Handoff Protocol%s  %s· installer · v%s%s\n' "$A" "$B" "$R" "$DIM" "$VERSION" "$R"
  printf '  %s%s─────────────────────────────────────────────%s\n' "$A" "$DIM" "$R"
  printf '    %srepo%s   %s\n' "$DIM" "$R" "$REPO"
  printf '    %sbin%s    %s\n' "$DIM" "$R" "$BIN_DIR"
  printf '    %sstore%s  %s\n' "$DIM" "$R" "$STORE"
}

# arrow-key menu -> $MENU_CHOICE (0-based). Falls back to a numbered prompt.
# Each option is "LABEL|DESCRIPTION". The label is a fixed one-line row; the
# description of the selected option is shown below and may wrap freely — the
# redraw erases to end-of-screen so a wrapped description stays one unit.
menu() {
  local title="$1"; shift
  local opts=("$@") n=${#opts[@]} sel=0 key
  printf '\n%s%s%s\n' "$B" "$title" "$R"

  if [ ! -t 0 ] || [ ! -t 1 ]; then
    local i=1
    for o in "${opts[@]}"; do printf '  %d) %s — %s\n' "$i" "${o%%|*}" "${o#*|}"; i=$((i+1)); done
    printf 'choose [1-%d]: ' "$n"
    read -r sel </dev/tty 2>/dev/null || sel=1
    case "$sel" in ''|*[!0-9]*) sel=1 ;; esac
    [ "$sel" -ge 1 ] && [ "$sel" -le "$n" ] || sel=1
    MENU_CHOICE=$((sel - 1))
    return
  fi

  # A wrapped description stays one logical unit: we save the cursor at the top
  # of the block and, on every redraw, restore to it and erase to end of screen
  # — so no line-count arithmetic and wrapping is handled by the terminal.
  _render() {
    local i
    for i in $(seq 0 $((n-1))); do
      local L="${opts[$i]%%|*}"
      if [ "$i" -eq "$sel" ]; then printf '  %s%s❯ %s%s\n' "$A" "$B" "$L" "$R"
      else printf '    %s\n' "$L"; fi
    done
    printf '    %s%s%s\n' "$DIM" "${opts[$sel]#*|}" "$R"
  }

  printf '%s' $'\033[?25l\033[s'
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
    printf '\033[u\033[J'
    _render
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
  for cli in claude codex; do
    command -v "$cli" >/dev/null 2>&1 || continue
    if [ "$DRY" = 1 ]; then dry "remove MCP registration" "$cli mcp remove agent-handoff"; continue; fi
    "$cli" mcp get agent-handoff >/dev/null 2>&1 || { skip "no MCP registration" "$cli"; continue; }
    removed=0
    for s in "" "-s user" "-s local" "-s project"; do
      # shellcheck disable=SC2086
      "$cli" mcp remove agent-handoff $s >/dev/null 2>&1 && { removed=1; break; }
    done
    [ "$removed" = 1 ] && ok "removed MCP registration" "$cli" || warn "MCP remove failed" "$cli mcp remove agent-handoff"
  done
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
                    *) hint "later: add  export PATH=\"$BIN_DIR:\$PATH\"  to your shell rc" ;; esac
    else
      hint "add  export PATH=\"$BIN_DIR:\$PATH\"  to your shell rc"
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
  menu "How should agents call ahp?" \
    "cli + mcp|also expose native ahp_* tools via an MCP server  (recommended)" \
    "cli|just the ahp CLI — the skill / AGENTS.md snippet teach the workflow"
  case "$MENU_CHOICE" in 1) MODE=cli ;; *) MODE=mcp ;; esac
fi
case "$MODE" in skill) MODE=cli ;; esac  # accept the old name
line "»" "$A" "mode" "$MODE"

# ---- the workflow: skill + AGENTS.md snippet, always deployed ----------
install_procedure() {
  section "Workflow"
  if [ "$HAS_CLAUDE" = 1 ] || [ -d "$HOME/.claude" ]; then
    if [ "$DRY" = 1 ]; then dry "install Claude Code skill" "$CLAUDE_SKILL_DIR"
    else
      mkdir -p "$(dirname "$CLAUDE_SKILL_DIR")"
      rm -rf "$CLAUDE_SKILL_DIR"
      cp -R "$REPO/skills/claude-code/agent-handoff-protocol" "$CLAUDE_SKILL_DIR"
      if [ -f "$CLAUDE_SKILL_DIR/SKILL.md" ]; then
        ok "Claude Code skill" "$CLAUDE_SKILL_DIR"
        hint "loads on: \"handoff\", \"pick up\", \"resume work\""
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
# Register with each host's own MCP CLI. Returns 1 only when the CLI is absent
# (so the caller shows a copy-paste fallback). Extra args after the cli name are
# passed to `mcp add` (e.g. --scope user for Claude Code, whose default is a
# directory-local entry).
register_host() {
  local host="$1" cli="$2"; shift 2
  if [ "$DRY" = 1 ]; then dry "register with $host" "$cli mcp add $* agent-handoff -- node …/ahp-mcp"; return 0; fi
  command -v "$cli" >/dev/null 2>&1 || return 1

  if "$cli" mcp get agent-handoff >/dev/null 2>&1; then
    local sc scl; sc=$("$cli" mcp get agent-handoff 2>/dev/null | sed -n 's/.*[Ss]cope:[[:space:]]*//p' | head -1)
    scl=$(printf '%s' "${sc%% *}" | tr 'A-Z' 'a-z')
    case "$scl" in
      user|global|"") skip "$host MCP entry" "already registered" ;;
      *) warn "$host MCP entry" "registered at ${scl} scope — active only there"
         hint "make it machine-wide:  $cli mcp remove agent-handoff -s ${scl}  &&  re-run this installer" ;;
    esac
    return 0
  fi

  local out
  if out=$("$cli" mcp add "$@" agent-handoff -- node "$REPO/bin/ahp-mcp" 2>&1); then
    ok "registered with $host" "restart $host to load it"
    "$cli" mcp get agent-handoff >/dev/null 2>&1 && ok "$host entry confirmed" "$cli mcp get agent-handoff"
  else
    bad "$cli mcp add failed" "$(printf '%s' "$out" | grep -v '^[[:space:]]*$' | head -1)"
    hint "add it by hand — see integrations/mcp.md"
  fi
}

install_mcp() {
  section "MCP server"

  register_host "Claude Code" claude --scope user || {
    warn "Claude Code CLI" "not found — add to ~/.claude.json by hand:"
    snippet <<EOF
{ "mcpServers": { "agent-handoff": { "command": "node", "args": ["$REPO/bin/ahp-mcp"] } } }
EOF
  }

  register_host "Codex" codex || {
    [ -d "$HOME/.codex" ] && {
      warn "Codex CLI" "not found — add to ~/.codex/config.toml by hand:"
      snippet <<EOF
[mcp_servers.agent-handoff]
command = "node"
args = ["$REPO/bin/ahp-mcp"]
EOF
    }
  }

  if [ "$DRY" != 1 ]; then
    if printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
      | node "$REPO/bin/ahp-mcp" 2>/dev/null | grep -q '"serverInfo"'; then
      ok "MCP server self-test" "initialize handshake OK · 8 tools"
    else bad "MCP server self-test failed"; fi
  fi
}

case "$MODE" in
  cli|mcp) install_procedure ;;
  *) printf '\n  %sunknown --mode: %s (cli | mcp)%s\n\n' "$ERRC" "$MODE" "$R"; exit 2 ;;
esac
[ "$MODE" = mcp ] && install_mcp

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
printf '  %s%s✓ installed%s  (mode: %s%s%s)\n' "$OKC" "$B" "$R" "$B" "$MODE" "$R"

printf '\n  %sTry it%s   %sfrom inside any git repo%s\n' "$B" "$R" "$DIM" "$R"
printf '    %s%-14s%s %swhere things stand%s\n' "$B" "ahp status" "$R" "$DIM" "$R"
printf '    %s%-14s%s %sbefore you start work%s\n' "$B" "ahp pickup" "$R" "$DIM" "$R"

printf '\n  %sDocs%s\n' "$B" "$R"
printf '    %s%-18s%s %s\n' "$DIM" "the protocol" "$R" "$REPO/SPEC.md"
printf '    %s%-18s%s %s\n' "$DIM" "adopting it" "$R" "$REPO/docs/adoption.md"
printf '    %s%-18s%s %s\n' "$DIM" "rationale & FAQ" "$R" "$REPO/docs/rationale.md"
printf '\n'
