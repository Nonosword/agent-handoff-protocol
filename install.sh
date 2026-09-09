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
# Agent CLIs are commonly installed into this same dir (Claude Code and Codex
# both default to ~/.local/bin). On a fresh machine it is not on PATH yet, so
# without adopting it here the host detection below reports them "not found"
# and silently skips the MCP registration. Remember the real state first, so
# the report still tells the user what their own shell will see.
BIN_ON_PATH=0; case ":$PATH:" in *":$BIN_DIR:"*) BIN_ON_PATH=1 ;; esac
[ "$BIN_ON_PATH" = 1 ] || export PATH="$BIN_DIR:$PATH"
STORE="${AHP_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-handoff}"
CLAUDE_SKILL_DIR="$HOME/.claude/skills/agent-handoff-protocol"
# Claude Desktop is a distinct MCP host from Claude Code. It owns a dedicated
# JSON configuration, whereas Claude Code is registered through `claude mcp`.
# Keep an override for tests and non-standard desktop installations.
CLAUDE_DESKTOP_MCP="${CLAUDE_DESKTOP_MCP:-$HOME/Library/Application Support/Claude/claude_desktop_config.json}"
CLAUDE_DESKTOP_APP="${CLAUDE_DESKTOP_APP:-/Applications/Claude.app}"
CODEX_AGENTS="$HOME/.codex/AGENTS.md"
# JSON-config hosts: each owns a dedicated MCP-only file (never a shared
# settings file), so a safe merge-in-place is possible (see json_mcp_register).
CURSOR_MCP="$HOME/.cursor/mcp.json"
WINDSURF_MCP="$HOME/.codeium/windsurf/mcp_config.json"
case "$(uname -s 2>/dev/null)" in
  Darwin) VSCODE_MCP="$HOME/Library/Application Support/Code/User/mcp.json" ;;
  *)      VSCODE_MCP="${XDG_CONFIG_HOME:-$HOME/.config}/Code/User/mcp.json" ;;
esac
# Qoder and Qoder CN are separate products. Keep every discovery and registration
# handle separate: the CN CLI has --add-mcp, not Qoder's mcp add/list/remove API.
QODER_APP="${QODER_APP:-/Applications/Qoder.app}"
QODER_CONFIG="${QODER_CONFIG:-$HOME/.qoder}"
QODER_CN_APP="${QODER_CN_APP:-/Applications/Qoder CN IDE.app}"
QODER_CN_CONFIG="${QODER_CN_CONFIG:-$HOME/.qoder-cn}"
QODER_CN_MCP="$QODER_CN_CONFIG/mcp.json"
QODER_CLI="${QODER_CLI:-}"
if [ -z "$QODER_CLI" ] && command -v qoder >/dev/null 2>&1; then QODER_CLI="$(command -v qoder)"; fi
QODER_CN_CLI="${QODER_CN_CLI:-}"
if [ -z "$QODER_CN_CLI" ] && command -v qoder-cn >/dev/null 2>&1; then
  QODER_CN_CLI="$(command -v qoder-cn)"
elif [ -z "$QODER_CN_CLI" ] && [ -x "$QODER_CN_APP/Contents/Resources/app/bin/qoder-cn" ]; then
  QODER_CN_CLI="$QODER_CN_APP/Contents/Resources/app/bin/qoder-cn"
fi
[ -n "$QODER_CLI" ] && [ ! -x "$QODER_CLI" ] && QODER_CLI=""
[ -n "$QODER_CN_CLI" ] && [ ! -x "$QODER_CN_CLI" ] && QODER_CN_CLI=""
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
    # 2>/dev/null must precede </dev/tty: on macOS, opening /dev/tty with no
    # controlling terminal fails with "Device not configured", and the shell
    # writes that redirection error to the original stderr unless fd 2 is
    # already redirected at the point the open is attempted.
    read -r sel 2>/dev/null </dev/tty || { sel=1; printf '\n'; }
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

  # Draining the rest of an escape sequence needs a sub-second timeout, but
  # macOS ships bash 3.2 and its `read -t` rejects a fractional argument
  # ("invalid timeout specification"), which broke arrow keys on a stock Mac.
  # Use 0.1s where supported, fall back to an integer second on bash < 4.
  local esc_t=0.1; [ "${BASH_VERSINFO:-0}" -lt 4 ] && esc_t=1

  printf '%s' $'\033[?25l\033[s'
  _render
  while true; do
    IFS= read -rsn1 key </dev/tty
    case "$key" in
      $'\033') read -rsn2 -t "$esc_t" key </dev/tty
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

# Cursor / VS Code / Windsurf have no MCP registration CLI: the only path is
# their own JSON file. Each owns a file dedicated to MCP servers (never a
# shared settings file), so a real JSON parse-and-merge is safe — never touch
# a file this can't parse (`parse_error`), and never overwrite unrelated keys.
# op: set (register) | delete (uninstall). Uses node (already required); no
# new dependency, no sed/awk-on-JSON. Defined here (ahead of both the
# uninstall block below and install_mcp further down) so both can call it.
json_mcp_op() {
  # Node 20 is already a prerequisite. Keep the complete update in one
  # process: a cooperating installer holds a short lock; a non-cooperating
  # host writer is detected by a content fingerprint immediately before the
  # atomic replacement and gets one fresh read/merge attempt.
  node - "$@" <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const [op, file, key, name, entryJson] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const fingerprint = (text, exists) => exists ? crypto.createHash("sha256").update(text).digest("hex") : "absent";

function readDocument() {
  let text = "";
  let exists = false;
  try { text = fs.readFileSync(file, "utf8"); exists = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const trimmed = text.trim();
  let doc = {};
  if (trimmed) {
    try { doc = JSON.parse(trimmed); }
    catch { return { parseError: true }; }
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { parseError: true };
  return { doc, fingerprint: fingerprint(text, exists) };
}

function writeAll(fd, text) {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error("short write while updating MCP JSON");
    offset += written;
  }
}

function atomicReplace(text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.ahp.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    writeAll(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

function acquireLock() {
  const lock = `${file}.ahp.lock`;
  const token = `${process.pid}\n${Date.now()}\n${Math.random().toString(36).slice(2)}\n`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
      writeAll(fd, token);
      fs.fsyncSync(fd);
      return { lock, token };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const pid = Number.parseInt(fs.readFileSync(lock, "utf8").split("\n", 1)[0], 10);
        if (!ownerAlive(pid)) { fs.rmSync(lock, { force: true }); continue; }
      } catch { /* an unreadable lock is never safe to reclaim */ }
      sleep(20);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  throw new Error(`could not acquire MCP configuration lock: ${lock}`);
}

function releaseLock({ lock, token }) {
  try { if (fs.readFileSync(lock, "utf8") === token) fs.rmSync(lock, { force: true }); }
  catch { /* best effort */ }
}

let entry;
if (op === "set") {
  try { entry = JSON.parse(entryJson); }
  catch { console.error("invalid MCP server JSON"); process.exit(1); }
}
fs.mkdirSync(path.dirname(file), { recursive: true });
const lock = acquireLock();
let output;
try {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = readDocument();
    if (before.parseError) { output = "parse_error"; break; }
    const doc = before.doc;
    if (!doc[key] || typeof doc[key] !== "object" || Array.isArray(doc[key])) doc[key] = {};
    let result;
    if (op === "delete") {
      if (!(name in doc[key])) { output = "absent"; break; }
      delete doc[key][name];
      result = "removed";
    } else {
      const cur = doc[key][name];
      if (cur && JSON.stringify(cur) === JSON.stringify(entry)) { output = "unchanged"; break; }
      doc[key][name] = entry;
      result = cur ? "updated" : "added";
    }
    // A host that does not observe our lock may have changed the file after
    // our read. Re-read and merge once from that current content instead of
    // blindly replacing it with a stale document.
    const latest = readDocument();
    if (latest.parseError) { output = "parse_error"; break; }
    if (latest.fingerprint !== before.fingerprint) {
      if (attempt === 0) continue;
      throw new Error("MCP configuration changed repeatedly during merge; retry the installer");
    }
    atomicReplace(JSON.stringify(doc, null, 2) + "\n");
    output = result;
    break;
  }
} finally {
  releaseLock(lock);
}
console.log(output);
NODE
}

json_mcp_register() {
  local host="$1" file="$2" key="$3" entry_json="$4" result
  if [ "$DRY" = 1 ]; then dry "register with $host" "$file"; return 0; fi
  mkdir -p "$(dirname "$file")"
  result=$(json_mcp_op set "$file" "$key" agent-handoff "$entry_json" 2>&1) || result="error: $result"
  case "$result" in
    added|updated) ok "registered with $host" "$file — restart $host to load it" ;;
    unchanged) skip "$host MCP entry" "current — restart $host to load code updates" ;;
    parse_error) warn "$host config not valid JSON" "$file — add it by hand, see integrations/mcp.md" ;;
    *) bad "$host registration failed" "$result" ;;
  esac
}

json_mcp_unregister() {
  local host="$1" file="$2" key="$3" result
  [ -f "$file" ] || { skip "no MCP registration" "$host"; return 0; }
  if [ "$DRY" = 1 ]; then dry "remove MCP registration" "$file"; return 0; fi
  result=$(json_mcp_op delete "$file" "$key" agent-handoff 2>&1) || result="error: $result"
  case "$result" in
    removed) ok "removed MCP registration" "$file" ;;
    absent) skip "no MCP registration" "$host" ;;
    parse_error) warn "$host config not valid JSON" "$file — left as-is" ;;
    *) bad "$host unregister failed" "$result" ;;
  esac
}

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" = 1 ]; then
  banner
  section "Uninstall"
  for b in ahp ahp-mcp; do
    if [ -L "$BIN_DIR/$b" ]; then
      t="$(readlink "$BIN_DIR/$b")"
      case "$t" in
        */bin/ahp|*/bin/ahp-mcp)
          [ "$DRY" = 1 ] && dry "remove command" "$BIN_DIR/$b" || { rm -f "$BIN_DIR/$b"; ok "removed command" "$BIN_DIR/$b"; } ;;
        *) warn "left as-is" "$BIN_DIR/$b → $t (not ours)" ;;
      esac
    elif [ -e "$BIN_DIR/$b" ]; then skip "not a symlink — left as-is" "$BIN_DIR/$b"
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
  if [ -n "$QODER_CLI" ]; then
    if [ "$DRY" = 1 ]; then dry "remove MCP registration" "$QODER_CLI mcp remove agent-handoff"
    elif "$QODER_CLI" mcp remove agent-handoff >/dev/null 2>&1; then ok "removed MCP registration" "Qoder"
    else skip "no MCP registration" "Qoder"; fi
  fi
  # Qoder CN has no remove subcommand. Its dedicated MCP JSON can be edited
  # safely by the existing parse-and-merge helper without touching Qoder.
  [ -f "$QODER_CN_MCP" ] && json_mcp_unregister "Qoder CN" "$QODER_CN_MCP" mcpServers
  json_mcp_unregister "Claude Desktop" "$CLAUDE_DESKTOP_MCP" mcpServers
  json_mcp_unregister "Cursor" "$CURSOR_MCP" mcpServers
  json_mcp_unregister "VS Code" "$VSCODE_MCP" servers
  json_mcp_unregister "Windsurf" "$WINDSURF_MCP" mcpServers
  printf '\n  %sThe store at %s was left intact.%s\n\n' "$DIM" "$STORE" "$R"
  exit 0
fi

# ---------------------------------------------------------------- install
banner

section "Preflight"
if command -v node >/dev/null 2>&1; then
  NV="$(node -p 'process.versions.node')"
  MAJ="${NV%%.*}"
  if [ "$MAJ" -ge 20 ] 2>/dev/null; then ok "Node.js" "v$NV"; else bad "Node.js too old" "v$NV (need >= 20)"; fi
else bad "Node.js not found" "install Node >= 20"; fi
command -v git >/dev/null 2>&1 && ok "Git" "$(git --version | awk '{print $3}')" || bad "Git not found"
[ "$FAILED" = 1 ] && { printf '\n  %sfix the above and re-run.%s\n\n' "$ERRC" "$R"; exit 1; }

# Link $REPO/bin/<name> into $BIN_DIR, but never clobber a file that is not
# ours: an absent path or a symlink into some agent-handoff-protocol checkout is
# safe to (re)point; a real file, a directory, or a symlink to an unrelated
# target is left alone with a message.
LINKED_AHP=0
link_bin() {
  name="$1"; src="$REPO/bin/$name"; dst="$BIN_DIR/$name"
  _did() { [ "$name" = ahp ] && LINKED_AHP=1; ok "linked $name" "$dst"; }
  if [ -L "$dst" ]; then
    tgt="$(readlink "$dst")"
    case "$tgt" in /*) : ;; *) tgt="$(cd "$(dirname "$dst")" && cd "$(dirname "$tgt")" 2>/dev/null && pwd)/$(basename "$tgt")" ;; esac
    case "$tgt" in
      */bin/ahp|*/bin/ahp-mcp)
        if [ -f "$(dirname "$tgt")/../SPEC.md" ] || [ "$tgt" = "$src" ]; then
          ln -sf "$src" "$dst"; _did
        else warn "$name left as-is" "$dst → $tgt (not an AHP checkout; remove it or set AHP_BIN_DIR)"; fi ;;
      *) warn "$name left as-is" "$dst → $tgt (not ours; remove it or set AHP_BIN_DIR)" ;;
    esac
  elif [ -e "$dst" ]; then
    warn "$name left as-is" "$dst exists and is not a symlink — remove it or set AHP_BIN_DIR"
  else
    ln -s "$src" "$dst"; _did
  fi
}

section "Command line"
if [ "$DRY" = 1 ]; then
  dry "symlink ahp" "$BIN_DIR/ahp"
  dry "symlink ahp-mcp" "$BIN_DIR/ahp-mcp"
else
  mkdir -p "$BIN_DIR"
  link_bin ahp
  link_bin ahp-mcp
  if [ "$LINKED_AHP" = 1 ]; then
    if "$BIN_DIR/ahp" --version >/dev/null 2>&1; then ok "ahp runs" "$("$BIN_DIR/ahp" --version)"; else bad "ahp failed to run"; fi
  else
    hint "using the existing $BIN_DIR/ahp — run $REPO/bin/ahp directly to check this checkout"
  fi
fi
RC=""; RC_WRITTEN=0
if [ "$BIN_ON_PATH" = 1 ]; then
  [ "$DRY" = 1 ] || ok "on PATH" "$BIN_DIR"
else
  warn "not on PATH" "$BIN_DIR"
  case "${SHELL##*/}" in zsh) RC="$HOME/.zshrc" ;; bash) RC="$HOME/.bashrc" ;; esac
  RC_LINE="export PATH=\"$BIN_DIR:\$PATH\""
  if [ -n "$RC" ] && [ -f "$RC" ] && grep -qF "$RC_LINE" "$RC"; then
    # already added on an earlier run — the current shell just has not picked it
    # up. Re-running must not append a second identical line.
    RC_WRITTEN=1; ok "already in shell rc" "$RC — open a new shell, or: source $RC"
  elif [ -n "$RC" ] && [ "$DRY" != 1 ] && [ -t 0 ]; then
    printf '    add %s%s%s to %s now? [y/N] ' "$B" "$RC_LINE" "$R" "$RC"
    read -r yn 2>/dev/null </dev/tty || yn=n
    case "$yn" in y|Y) printf '\n%s\n' "$RC_LINE" >> "$RC"; RC_WRITTEN=1; ok "appended to shell rc" "$RC — open a new shell" ;;
                  *) hint "later: add  $RC_LINE  to your shell rc" ;; esac
  else
    hint "add  $RC_LINE  to your shell rc"
  fi
fi

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
# Do not infer the Desktop app from the Claude Code CLI (or vice versa). A
# config file is enough to identify an existing Desktop installation; the app
# bundle covers the first-run case before it has written a config file.
HAS_CLAUDE_DESKTOP=0; { [ -f "$CLAUDE_DESKTOP_MCP" ] || [ -d "$CLAUDE_DESKTOP_APP" ]; } && HAS_CLAUDE_DESKTOP=1
[ "$HAS_CLAUDE_DESKTOP" = 1 ] && ok "claude desktop" "detected" || skip "claude desktop" "not found"
# These hosts are independently detected through their own CLI, app or config.
HAS_CURSOR=0;   { command -v cursor  >/dev/null 2>&1 || [ -d "$HOME/.cursor" ]; }            && HAS_CURSOR=1
HAS_VSCODE=0;   { command -v code    >/dev/null 2>&1 || [ -d "$(dirname "$VSCODE_MCP")" ]; } && HAS_VSCODE=1
HAS_WINDSURF=0; { command -v windsurf >/dev/null 2>&1 || [ -d "$HOME/.codeium/windsurf" ]; }  && HAS_WINDSURF=1
HAS_QODER=0;    { [ -n "$QODER_CLI" ] || [ -d "$QODER_APP" ] || [ -d "$QODER_CONFIG" ]; } && HAS_QODER=1
HAS_QODER_CN=0; { [ -n "$QODER_CN_CLI" ] || [ -d "$QODER_CN_APP" ] || [ -d "$QODER_CN_CONFIG" ]; } && HAS_QODER_CN=1
[ "$HAS_CURSOR" = 1 ]   && ok "cursor" "detected"   || skip "cursor" "not found"
[ "$HAS_VSCODE" = 1 ]   && ok "vs code" "detected"  || skip "vs code" "not found"
[ "$HAS_WINDSURF" = 1 ] && ok "windsurf" "detected" || skip "windsurf" "not found"
if [ -n "$QODER_CLI" ]; then ok "qoder" "$("$QODER_CLI" --version 2>/dev/null | head -1)"
elif [ "$HAS_QODER" = 1 ]; then ok "qoder" "detected (CLI unavailable; $QODER_CONFIG)"
else skip "qoder" "not found"; fi
if [ -n "$QODER_CN_CLI" ]; then ok "qoder cn" "$("$QODER_CN_CLI" --version 2>/dev/null | head -1)"
elif [ "$HAS_QODER_CN" = 1 ]; then ok "qoder cn" "detected (CLI unavailable; $QODER_CN_CONFIG)"
else skip "qoder cn" "not found"; fi

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
    if [ "$DRY" = 1 ]; then dry "sync Codex AGENTS.md snippet" "$CODEX_AGENTS"
    else
      mkdir -p "$(dirname "$CODEX_AGENTS")"
      local had=0
      if [ -f "$CODEX_AGENTS" ] && grep -qF "$MARK_BEGIN" "$CODEX_AGENTS"; then
        had=1
        awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0==b{s=1} !s{print} $0==e{s=0}' "$CODEX_AGENTS" > "$CODEX_AGENTS.ahptmp" && mv "$CODEX_AGENTS.ahptmp" "$CODEX_AGENTS"
      fi
      { printf '\n%s\n' "$MARK_BEGIN"
        sed -n '/^```markdown$/,/^```$/p' "$REPO/integrations/codex-AGENTS.md" | sed '1d;$d'
        printf '%s\n' "$MARK_END"
      } >> "$CODEX_AGENTS"
      grep -qF "$MARK_BEGIN" "$CODEX_AGENTS" \
        && { [ "$had" = 1 ] && ok "Codex AGENTS.md snippet" "refreshed in place" || ok "Codex AGENTS.md snippet" "$CODEX_AGENTS"; } \
        || bad "AGENTS.md write failed"
    fi
  else skip "Codex" "no ~/.codex — skipped"; fi
}

# ---- mcp mode ----------------------------------------------------------
# Register with each host's own MCP CLI, or — if already registered — verify the
# entry still points at this repo and carries the worker-identity env, and
# re-register only if it drifted. Never a blind remove+add. Returns 1 only when
# the CLI is absent (so the caller shows a copy-paste fallback). Args after the
# cli name are passed to `mcp add` (scope + env flags, which differ per host).
register_host() {
  local host="$1" cli="$2"; shift 2
  local addargs=("$@")
  if [ "$DRY" = 1 ]; then dry "register with $host" "$cli mcp add … agent-handoff -- node …/ahp-mcp"; return 0; fi
  command -v "$cli" >/dev/null 2>&1 || return 1

  local _add
  _add() {
    local out
    # name first, then options, then `-- <command>` — Claude Code's `-e` is
    # variadic and would otherwise swallow the name.
    if out=$("$cli" mcp add agent-handoff "${addargs[@]}" -- node "$REPO/bin/ahp-mcp" 2>&1); then
      ok "registered with $host" "restart $host to load it"
    else
      bad "$cli mcp add failed" "$(printf '%s' "$out" | grep -v '^[[:space:]]*$' | head -1)"
      hint "add it by hand — see integrations/mcp.md"
    fi
  }

  if ! "$cli" mcp get agent-handoff >/dev/null 2>&1; then
    _add
    return 0
  fi

  local info sc scl
  info=$("$cli" mcp get agent-handoff 2>/dev/null)
  sc=$(printf '%s' "$info" | sed -n 's/.*[Ss]cope:[[:space:]]*//p' | head -1)
  scl=$(printf '%s' "${sc%% *}" | tr 'A-Z' 'a-z')
  case "$scl" in
    ""|user|global) : ;;
    *) warn "$host MCP entry" "registered at ${scl} scope — active only there"
       hint "make it machine-wide:  $cli mcp remove agent-handoff -s ${scl}  &&  re-run"
       return 0 ;;
  esac

  if printf '%s' "$info" | grep -q "$REPO/bin/ahp-mcp"; then
    skip "$host MCP entry" "current — code updates via git pull; restart $host to load"
  else
    warn "$host MCP entry" "points elsewhere — refreshing"
    "$cli" mcp remove agent-handoff >/dev/null 2>&1 || "$cli" mcp remove agent-handoff -s user >/dev/null 2>&1
    _add
  fi
}

# Qoder's global CLI exposes mcp add/list/remove. It is intentionally separate
# from Qoder CN, whose CLI only accepts --add-mcp <JSON>.
register_qoder() {
  [ -n "$QODER_CLI" ] || return 1
  if [ "$DRY" = 1 ]; then dry "register with Qoder" "$QODER_CLI mcp add … agent-handoff -- node …/ahp-mcp"; return 0; fi
  if "$QODER_CLI" mcp list 2>/dev/null | grep -q agent-handoff; then
    skip "Qoder MCP entry" "already registered — restart Qoder to load code updates"
    return 0
  fi
  local out
  if out=$("$QODER_CLI" mcp add agent-handoff -s user -- node "$REPO/bin/ahp-mcp" 2>&1); then
    ok "registered with Qoder" "restart Qoder to load it"
  else
    bad "Qoder mcp add failed" "$(printf '%s' "$out" | grep -v '^[[:space:]]*$' | head -1)"
    hint "add it by hand — see integrations/mcp.md"
  fi
}

qoder_cn_entry_current() {
  [ -f "$QODER_CN_MCP" ] || return 1
  node -e 'try { const fs = require("fs"); const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const entry = doc.mcpServers?.["agent-handoff"]; process.exit(entry?.command === "node" && entry?.args?.[0] === process.argv[2] ? 0 : 1); } catch { process.exit(1); }' "$QODER_CN_MCP" "$REPO/bin/ahp-mcp"
}

register_qoder_cn() {
  [ -n "$QODER_CN_CLI" ] || return 1
  local entry out
  entry=$(printf '{"name":"agent-handoff","command":"node","args":["%s/bin/ahp-mcp"]}' "$REPO")
  if [ "$DRY" = 1 ]; then dry "register with Qoder CN" "$QODER_CN_CLI --add-mcp <JSON>"; return 0; fi
  if qoder_cn_entry_current; then
    skip "Qoder CN MCP entry" "already registered — restart Qoder CN to load code updates"
    return 0
  fi
  if out=$("$QODER_CN_CLI" --add-mcp "$entry" 2>&1); then
    ok "registered with Qoder CN" "restart Qoder CN to load it"
  else
    bad "Qoder CN --add-mcp failed" "$(printf '%s' "$out" | grep -v '^[[:space:]]*$' | head -1)"
    hint "add it by hand — see integrations/mcp.md"
  fi
}

install_mcp() {
  section "MCP server"

  register_host "Claude Code" claude --scope user \
    -e AHP_WORKER_ID=claude -e AHP_MODEL=claude -e AHP_RUNTIME=claude-code || {
    warn "Claude Code CLI" "not found — add to ~/.claude.json by hand:"
    snippet <<EOF
{ "mcpServers": { "agent-handoff": { "command": "node", "args": ["$REPO/bin/ahp-mcp"],
    "env": { "AHP_WORKER_ID": "claude", "AHP_MODEL": "claude", "AHP_RUNTIME": "claude-code" } } } }
EOF
  }

  if [ "$HAS_CLAUDE_DESKTOP" = 1 ]; then
    # This is intentionally a JSON registration, not `claude mcp add`: Claude
    # Desktop does not share Claude Code's CLI-managed configuration.
    json_mcp_register "Claude Desktop" "$CLAUDE_DESKTOP_MCP" mcpServers \
      "$(printf '{"command":"node","args":["%s/bin/ahp-mcp"],"env":{"AHP_WORKER_ID":"claude","AHP_MODEL":"claude","AHP_RUNTIME":"claude-desktop"}}' "$REPO")"
  else skip "Claude Desktop" "not found"; fi

  register_host "Codex" codex \
    --env AHP_WORKER_ID=codex --env AHP_MODEL=codex --env AHP_RUNTIME=codex || {
    [ -d "$HOME/.codex" ] && {
      warn "Codex CLI" "not found — add to ~/.codex/config.toml by hand:"
      snippet <<EOF
[mcp_servers.agent-handoff]
command = "node"
args = ["$REPO/bin/ahp-mcp"]
env = { AHP_WORKER_ID = "codex", AHP_MODEL = "codex", AHP_RUNTIME = "codex" }
EOF
    }
  }

  if [ "$HAS_CURSOR" = 1 ]; then
    json_mcp_register "Cursor" "$CURSOR_MCP" mcpServers \
      "$(printf '{"command":"node","args":["%s/bin/ahp-mcp"],"env":{"AHP_WORKER_ID":"cursor","AHP_MODEL":"cursor","AHP_RUNTIME":"cursor"}}' "$REPO")"
  else skip "Cursor" "not found"; fi

  if [ "$HAS_VSCODE" = 1 ]; then
    # No forced worker id: Copilot Chat's model varies by session, unlike a
    # single-purpose agent CLI, so a forced id would misattribute more than it
    # helps. The MCP initialize handshake still gets a shot at it.
    json_mcp_register "VS Code" "$VSCODE_MCP" servers \
      "$(printf '{"type":"stdio","command":"node","args":["%s/bin/ahp-mcp"]}' "$REPO")"
  else skip "VS Code" "not found"; fi

  if [ "$HAS_WINDSURF" = 1 ]; then
    json_mcp_register "Windsurf" "$WINDSURF_MCP" mcpServers \
      "$(printf '{"command":"node","args":["%s/bin/ahp-mcp"],"env":{"AHP_WORKER_ID":"windsurf","AHP_MODEL":"windsurf","AHP_RUNTIME":"windsurf"}}' "$REPO")"
  else skip "Windsurf" "not found"; fi

  register_qoder || {
    [ "$HAS_QODER" = 1 ] && {
      warn "Qoder CLI" "not found — register by hand once its Qoder CLI is installed:"
      snippet <<EOF
qoder mcp add agent-handoff -s user -- node $REPO/bin/ahp-mcp
EOF
    }
  }
  register_qoder_cn || {
    [ "$HAS_QODER_CN" = 1 ] && {
      warn "Qoder CN CLI" "not found — use Qoder CN's own CLI, never qoder mcp:"
      snippet <<EOF
$QODER_CN_APP/Contents/Resources/app/bin/qoder-cn --add-mcp '{"name":"agent-handoff","command":"node","args":["$REPO/bin/ahp-mcp"]}'
EOF
    }
  }

  if [ "$DRY" != 1 ]; then
    if printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
      | node "$REPO/bin/ahp-mcp" 2>/dev/null | grep -q '"serverInfo"'; then
      ok "MCP server self-test" "initialize handshake OK · 11 tools"
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
  if [ "$BIN_ON_PATH" = 1 ]; then ok "ahp resolves on PATH" "$(command -v ahp)"
  elif [ "$RC_WRITTEN" = 1 ]; then warn "ahp resolves in a new shell" "now: source $RC"
  else warn "ahp not on PATH" "add  export PATH=\"$BIN_DIR:\$PATH\"  to your shell rc"; fi
  "$BIN_DIR/ahp" --version >/dev/null 2>&1 && ok "ahp --version" "$("$BIN_DIR/ahp" --version)" || bad "ahp --version failed"
fi

section "Done"
if [ "$FAILED" = 1 ]; then
  printf '  %s%s✗ finished with errors%s — see the ✗ lines above.\n\n' "$ERRC" "$B" "$R"
  exit 1
fi
printf '  %s%s✓ installed%s  (mode: %s%s%s)\n' "$OKC" "$B" "$R" "$B" "$MODE" "$R"

printf '\n  %sTry it%s\n' "$B" "$R"
printf '    %s%-14s%s %severy project at a glance — from anywhere  (-w = live)%s\n' "$B" "ahp dashboard" "$R" "$DIM" "$R"
printf '    %s%-14s%s %swhere things stand — inside a git repo%s\n' "$B" "ahp status" "$R" "$DIM" "$R"
printf '    %s%-14s%s %sbefore you start work — inside a git repo%s\n' "$B" "ahp pickup" "$R" "$DIM" "$R"

printf '\n  %sDocs%s\n' "$B" "$R"
printf '    %s%-18s%s %s\n' "$DIM" "the protocol" "$R" "$REPO/SPEC.md"
printf '    %s%-18s%s %s\n' "$DIM" "adopting it" "$R" "$REPO/docs/adoption.md"
printf '    %s%-18s%s %s\n' "$DIM" "rationale & FAQ" "$R" "$REPO/docs/rationale.md"
printf '\n'
