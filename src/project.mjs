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
import { explainStoreFsError } from "./storage-errors.mjs";
import { acquireLock, releaseLock, writeFileAtomic } from "./worklog.mjs";

function slug(s) {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 80) || "project";
}

function shortHash(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
}

export function loadRegistry(home) {
  const file = registryPath(home);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, projects: {} };
    throw explainStoreFsError(error, {
      operation: "read the project registry",
      target: file,
      effect: "The registry was not treated as empty and nothing was overwritten."
    });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`[AHP_REGISTRY_INVALID] Cannot parse ${file}: ${error.message}. AHP refuses to treat a corrupt registry as empty or overwrite it.`);
  }
  if (!data || typeof data !== "object" || !data.projects || typeof data.projects !== "object" || Array.isArray(data.projects)) {
    throw new Error(`[AHP_REGISTRY_INVALID] ${file} must contain a top-level projects object. AHP refuses to treat an invalid registry as empty or overwrite it.`);
  }
  return data;
}

export function saveRegistry(home, registry) {
  const file = registryPath(home);
  try {
    writeFileAtomic(file, `${JSON.stringify(registry, null, 2)}\n`);
  } catch (error) {
    throw explainStoreFsError(error, {
      operation: "update the project registry",
      target: file,
      effect: "The registry update did not complete; no worklog record was written."
    });
  }
}

function mutateRegistry(home, operation) {
  const file = registryPath(home);
  const lock = path.join(home, ".projects.lock");
  let token;
  try {
    token = acquireLock(lock);
  } catch (error) {
    throw explainStoreFsError(error, {
      operation: "lock the project registry",
      target: lock,
      effect: "No project registry change was written."
    });
  }
  try {
    // Re-read only after acquiring the global registry lock so two projects
    // registered concurrently cannot overwrite each other's entries.
    const registry = loadRegistry(home);
    const result = operation(registry);
    saveRegistry(home, registry);
    return result;
  } finally {
    releaseLock(lock, token);
  }
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
export function resolve({ cwd = process.cwd(), project = null, env = process.env, home, registerMissing = true }) {
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
  // Read-only commands can derive the stable descriptor without touching the
  // registry. The first write command will persist the same identity.
  if (!registerMissing) {
    return descriptor(ident.id, {
      name: ident.name,
      remote: ident.remote,
      roots: [ident.root],
      created: null
    }, home, { source: "git-unregistered" });
  }
  // unregistered but in a repo: auto-register before writing
  return register({ cwd, home, name: ident.name, autoreg: true });
}

function findInRegistry(registry, want) {
  if (registry.projects[want]) return { id: want, entry: registry.projects[want] };
  const named = Object.entries(registry.projects).filter(([, entry]) => entry.name === want);
  if (named.length === 1) {
    const [id, entry] = named[0];
    return { id, entry };
  }
  if (named.length > 1) throw new Error(`project name "${want}" is ambiguous: ${named.map(([id]) => id).join(", ")}. Use an explicit project id.`);
  return null;
}

function assertNameAvailable(registry, name, exceptId = null) {
  const collision = Object.entries(registry.projects).find(([id, entry]) => id !== exceptId && entry.name === name);
  if (collision) throw new Error(`project name "${name}" is already used by ${collision[0]}; choose a unique name or use that project's id.`);
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
    registered: !["explicit-unregistered", "git-unregistered"].includes(meta.source)
  };
}

// Add (or update) the project containing cwd to the registry.
export function register({ cwd = process.cwd(), home, name = null, autoreg = false }) {
  const ident = identify(cwd);
  if (!ident) throw new Error("not inside a Git repository");
  return mutateRegistry(home, (registry) => {
    const existing = registry.projects[ident.id] ?? { roots: [] };
    const entryName = name ?? existing.name ?? ident.name;
    assertNameAvailable(registry, entryName, ident.id);
    const entry = {
      name: entryName,
      remote: ident.remote ?? existing.remote ?? null,
      roots: [...new Set([...(existing.roots ?? []), ident.root])],
      created: existing.created ?? new Date().toISOString()
    };
    registry.projects[ident.id] = entry;
    return { ...descriptor(ident.id, entry, home, { source: autoreg ? "autoregistered" : "registered" }), autoreg };
  });
}

export function list(home) {
  const registry = loadRegistry(home);
  return Object.entries(registry.projects).map(([id, e]) => ({
    id, name: e.name ?? id, remote: e.remote ?? null, roots: e.roots ?? [], created: e.created ?? null
  }));
}

export function rename(home, idOrName, newName) {
  return mutateRegistry(home, (registry) => {
    const hit = findInRegistry(registry, idOrName);
    if (!hit) throw new Error(`unknown project: ${idOrName}`);
    assertNameAvailable(registry, newName, hit.id);
    registry.projects[hit.id].name = newName;
    return hit.id;
  });
}

export function forget(home, idOrName) {
  return mutateRegistry(home, (registry) => {
    const hit = findInRegistry(registry, idOrName);
    if (!hit) throw new Error(`unknown project: ${idOrName}`);
    delete registry.projects[hit.id];
    return hit.id;
  });
}
