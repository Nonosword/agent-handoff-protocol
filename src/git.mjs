// Thin, read-only Git helpers. Every call is `git` with a fixed argv and
// shell:false. AHP never mutates a project's Git state.

import { spawnSync } from "node:child_process";

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  // Some sandboxed runtimes (e.g. agent execution environments) attach an
  // EPERM/EACCES `.error` to the result even when the command actually ran —
  // real stdout, a concrete exit status. Trust the exit status whenever we have
  // one; only treat `.error` as fatal when the process produced no status at
  // all (a genuine spawn failure: git missing, blocked outright).
  const status = typeof res.status === "number" ? res.status : null;
  if (status === null && res.error) {
    return { ok: false, code: -1, out: "", err: String(res.error.message) };
  }
  return { ok: status === 0, code: status ?? -1, out: (res.stdout ?? "").trim(), err: (res.stderr ?? "").trim() };
}

export function isGitRepo(cwd) {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]).out === "true";
}

export function topLevel(cwd) {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out : null;
}

export function headCommit(cwd) {
  const r = git(cwd, ["rev-parse", "HEAD"]);
  return r.ok ? r.out : null;
}

export function shortCommit(cwd, ref = "HEAD") {
  const r = git(cwd, ["rev-parse", "--short", ref]);
  return r.ok ? r.out : null;
}

export function branch(cwd) {
  const r = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok ? r.out : null;
}

export function isClean(cwd) {
  const r = git(cwd, ["status", "--porcelain"]);
  return r.ok ? r.out === "" : null;
}

export function dirtyPaths(cwd) {
  const r = git(cwd, ["status", "--porcelain"]);
  if (!r.ok || r.out === "") return [];
  return r.out.split("\n").map((l) => l.trim());
}

export function remoteUrl(cwd, name = "origin") {
  const r = git(cwd, ["remote", "get-url", name]);
  return r.ok && r.out !== "" ? r.out : null;
}

// Normalize a remote URL to a stable identity key:
//   git@github.com:User/Repo.git  ->  github.com/user/repo
//   https://github.com/User/Repo  ->  github.com/user/repo
export function normalizeRemote(url) {
  if (!url) return null;
  let s = url.trim();
  s = s.replace(/^[a-z]+:\/\//i, "");
  s = s.replace(/^git@/i, "");
  s = s.replace(/^ssh:\/\//i, "");
  s = s.replace(/^[^@/]+@/, "");
  s = s.replace(/:/, "/");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}

// One-line log entries for base..HEAD (oldest first).
export function logRange(cwd, from, to = "HEAD") {
  const r = git(cwd, ["log", "--reverse", "--pretty=%h\t%s", `${from}..${to}`]);
  if (!r.ok || r.out === "") return [];
  return r.out.split("\n").map((line) => {
    const tab = line.indexOf("\t");
    return { short: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
}

export function isAncestor(cwd, ancestor, descendant = "HEAD") {
  return git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).code === 0;
}

export function commitExists(cwd, ref) {
  return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok;
}
