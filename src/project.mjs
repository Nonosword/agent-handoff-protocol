// Project identity + registry.
//
// A project's id is derived from Git, so `ahp` works from any subdirectory and
// recognizes the same project after a re-clone (when it has a remote):
//   - remote `origin` present  -> slug of the normalized remote URL
//   - no remote                -> "<basename>-<short hash of the toplevel path>"
//
// The registry (<store>/projects.json) records name, remote and every local
// path a project has been seen at, so a moved checkout still resolves.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as git from "./git.mjs";
import { registryPath, projectDir, worklogPath, lockPath } from "./paths.mjs";

function slug(s) {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 80) || "project";
}

function shortHash(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
}

export function loadRegistry(home) {
  try {
    const data = JSON.parse(fs.readFileSync(registryPath(home), "utf8"));
    if (data && typeof data === "object" && data.projects) return data;
  } catch { /* fall through */ }
  return { version: 1, projects: {} };
}

export function saveRegistry(home, registry) {
  const file = registryPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Compute the id + descriptor for whatever project contains `cwd`.
export function identify(cwd) {
  if (!git.isGitRepo(cwd)) return null;
  const top = git.topLevel(cwd);
  const remote = git.remoteUrl(cwd);
  const normRemote = git.normalizeRemote(remote);
  const id = normRemote ? slug(normRemote) : `${slug(path.basename(top))}-${shortHash(top)}`;
  return { id, root: top, remote: remote ?? null, normRemote: normRemote ?? null, name: path.basename(top) };
}

// Resolve the active project. Precedence: explicit > env > cwd git > error.
export function resolve({ cwd = process.cwd(), project = null, env = process.env, home }) {
  const registry = loadRegistry(home);
  const want = project ?? (env.AHP_PROJECT && env.AHP_PROJECT.trim() !== "" ? env.AHP_PROJECT : null);

  if (want) {
    const hit = findInRegistry(registry, want);
    if (hit) return descriptor(hit.id, hit.entry, home, { source: "explicit" });
    // allow an explicit id that isn't registered yet only if it's clean
    if (/^[a-z0-9][a-z0-9._-]*$/i.test(want)) {
      return descriptor(want, { name: want, remote: null, roots: [] }, home, { source: "explicit-unregistered" });
    }
    throw new Error(`unknown project: ${want} (see \`ahp project list\`)`);
  }

  const ident = identify(cwd);
  if (!ident) {
    throw new Error("not inside a Git repository — pass --project <id|name> or run `ahp project add`");
  }
  // match registry by id, remote or a known root
  for (const [id, entry] of Object.entries(registry.projects)) {
    if (id === ident.id) return descriptor(id, entry, home, { source: "git" });
    if (ident.normRemote && entry.remote && git.normalizeRemote(entry.remote) === ident.normRemote) {
      return descriptor(id, entry, home, { source: "git-remote" });
    }
    if ((entry.roots ?? []).includes(ident.root)) return descriptor(id, entry, home, { source: "git-path" });
  }
  // unregistered but in a repo: auto-register
  return register({ cwd, home, name: ident.name, autoreg: true });
}

function findInRegistry(registry, want) {
  if (registry.projects[want]) return { id: want, entry: registry.projects[want] };
  for (const [id, entry] of Object.entries(registry.projects)) {
    if (entry.name === want) return { id, entry };
  }
  return null;
}

function descriptor(id, entry, home, meta) {
  return {
    id,
    name: entry.name ?? id,
    remote: entry.remote ?? null,
    roots: entry.roots ?? [],
    dir: projectDir(id, home),
    worklog: worklogPath(id, home),
    lock: lockPath(id, home),
    source: meta.source,
    registered: meta.source !== "explicit-unregistered"
  };
}

// Add (or update) the project containing cwd to the registry.
export function register({ cwd = process.cwd(), home, name = null, autoreg = false }) {
  const ident = identify(cwd);
  if (!ident) throw new Error("not inside a Git repository");
  const registry = loadRegistry(home);
  const existing = registry.projects[ident.id] ?? { roots: [] };
  const entry = {
    name: name ?? existing.name ?? ident.name,
    remote: ident.remote ?? existing.remote ?? null,
    roots: [...new Set([...(existing.roots ?? []), ident.root])],
    created: existing.created ?? new Date().toISOString()
  };
  registry.projects[ident.id] = entry;
  saveRegistry(home, registry);
  return { ...descriptor(ident.id, entry, home, { source: autoreg ? "autoregistered" : "registered" }), autoreg };
}

export function list(home) {
  const registry = loadRegistry(home);
  return Object.entries(registry.projects).map(([id, e]) => ({
    id, name: e.name ?? id, remote: e.remote ?? null, roots: e.roots ?? [], created: e.created ?? null
  }));
}

export function rename(home, idOrName, newName) {
  const registry = loadRegistry(home);
  const hit = findInRegistry(registry, idOrName);
  if (!hit) throw new Error(`unknown project: ${idOrName}`);
  registry.projects[hit.id].name = newName;
  saveRegistry(home, registry);
  return hit.id;
}

export function forget(home, idOrName) {
  const registry = loadRegistry(home);
  const hit = findInRegistry(registry, idOrName);
  if (!hit) throw new Error(`unknown project: ${idOrName}`);
  delete registry.projects[hit.id];
  saveRegistry(home, registry);
  return hit.id;
}
