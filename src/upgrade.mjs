// `ahp upgrade` — self-update this checkout, then re-run the installer so every
// host picks up the new skill / MCP registration. All local: `git` against
// AHP's own checkout (never a user project) and AHP's own `install.sh`. No
// network primitive; nothing is sent anywhere (SPEC §11).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The checkout to update. Defaults to the one this file lives in; AHP_REPO is
// an escape hatch for a non-standard layout (and lets the tests drive it).
const REPO = process.env.AHP_REPO ? path.resolve(process.env.AHP_REPO) : path.resolve(HERE, "..");

const git = (...args) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" });
const readVersion = () => {
  try { return JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version; }
  catch { return "?"; }
};

const RECONNECT = `
ahp behaviour and bug fixes are live already — every ahp-mcp call shells out to
this checkout. Only a *new MCP tool or parameter* needs the host to respawn its
ahp-mcp process (the tool list is read once, at start):
  Claude Code (terminal)   /mcp  → agent-handoff → Reconnect
  Claude Code (desktop)    the MCP panel has no per-server reconnect — quit and
                           reopen the app
  Codex                    restart codex
  Cursor / VS Code / Windsurf   restart the editor
`;

export async function upgrade({ check = false } = {}) {
  const out = (s) => process.stdout.write(`${s}\n`);
  const err = (s) => process.stderr.write(`${s}\n`);

  if (!fs.existsSync(path.join(REPO, ".git"))) {
    err(`ahp: ${REPO} is not a git checkout — update it however you installed it.`);
    return 1;
  }
  const before = readVersion();
  const dirty = git("status", "--porcelain").stdout.trim();
  if (dirty) {
    err(`ahp: ${REPO} has uncommitted changes — commit or stash them first:\n${dirty}`);
    return 1;
  }

  out(`checking ${REPO} …`);
  const fetch = git("fetch", "--quiet");
  if (fetch.status !== 0) { err(`ahp: git fetch failed:\n${fetch.stderr.trim()}`); return 1; }

  const branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  const upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  if (upstream.status !== 0) {
    err(`ahp: ${branch} has no upstream — set one, or pull ${REPO} by hand.`);
    return 1;
  }
  const behind = git("rev-list", "--count", "HEAD..@{upstream}").stdout.trim();

  if (behind === "0") {
    out(`already current — ${before} (${branch})`);
    if (!check) refreshHosts(out, err);
    return 0;
  }
  if (check) {
    out(`${behind} commit(s) behind ${upstream.stdout.trim()}. run \`ahp upgrade\` to apply.`);
    return 0;
  }

  const ff = git("merge", "--ff-only", "@{upstream}");
  if (ff.status !== 0) {
    err(`ahp: fast-forward failed — ${branch} has diverged from its upstream.\n${ff.stderr.trim()}\nresolve it in ${REPO} by hand, then re-run.`);
    return 1;
  }
  const after = readVersion();
  const head = git("rev-parse", "--short", "HEAD").stdout.trim();
  out(after === before
    ? `updated — ${after} (${head}), ${behind} commit(s) pulled`
    : `updated ${before} → ${after} (${head})`);
  refreshHosts(out, err);
  return 0;
}

function refreshHosts(out, err) {
  const installer = path.join(REPO, "install.sh");
  if (!fs.existsSync(installer)) { err(`ahp: ${installer} missing — skipped host refresh.`); return; }
  out("");
  const r = spawnSync("bash", [installer, "--mode", "mcp", "--no-color"], { stdio: "inherit" });
  if (r.status !== 0) err(`ahp: installer exited ${r.status ?? "?"} — check its output above.`);
  out(RECONNECT.trimEnd());
}
