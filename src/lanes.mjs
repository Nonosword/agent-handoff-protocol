// Project-local work streams stored beside, but never inside, the project repo.
// Existing project-wide worklogs are exposed as the synthetic "main" lane.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { explainStoreFsError } from "./storage-errors.mjs";
import { acquireLock, releaseLock, analyze, readEntries, writeFileAtomic } from "./worklog.mjs";

export const LEGACY_LANE_ID = "main";
export const LEGACY_LANE_TITLE = "Main / legacy";
// `blocked` existed before the lifecycle model was made explicit. Keep reading
// it so historical registries remain usable, but never offer it as a new state.
export const LANE_STATUSES = new Set(["active", "done", "archived"]);
const STORED_LANE_STATUSES = new Set([...LANE_STATUSES, "blocked"]);
const LEGACY_LANE_METADATA = {
  title: LEGACY_LANE_TITLE,
  description: "Project-wide records written before Lane support.",
  scope: [],
  aliases: [],
  status: "active"
};

const laneFile = (project) => path.join(project.dir, "lanes.json");
const normalized = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase()
  .replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "");

export function slug(value) {
  return Array.from(normalized(value)).slice(0, 60).join("") || "work";
}

function hasLegacyWorklog(project) {
  try { return fs.statSync(project.worklog).size > 0; }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function validateFile(data) {
  if (!data || data.version !== 1 || !data.lanes || typeof data.lanes !== "object" || Array.isArray(data.lanes)) {
    throw new Error("expected { version: 1, lanes: { ... } }");
  }
  const routed = new Map();
  for (const [id, entry] of Object.entries(data.lanes)) {
    if (id !== slug(id)) throw new Error(`Lane id "${id}" is not a canonical safe id`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Lane "${id}" must be an object`);
    if (typeof entry.title !== "string" || !entry.title.trim()) throw new Error(`Lane "${id}" needs a non-empty title`);
    if (typeof entry.description !== "string" || !entry.description.trim()) throw new Error(`Lane "${id}" needs a non-empty description`);
    if (!STORED_LANE_STATUSES.has(entry.status)) throw new Error(`Lane "${id}" has an invalid status`);
    for (const field of ["scope", "aliases"]) {
      if (!Array.isArray(entry[field]) || entry[field].some((value) => typeof value !== "string" || !value.trim())) {
        throw new Error(`Lane "${id}" ${field} must be an array of non-empty strings`);
      }
    }
    if (entry.verificationDisposition != null) {
      const disposition = entry.verificationDisposition;
      if (!disposition || typeof disposition !== "object" || Array.isArray(disposition) ||
          typeof disposition.at !== "string" || !disposition.at ||
          typeof disposition.reason !== "string" || !disposition.reason.trim() ||
          typeof disposition.worklogSha256 !== "string" || !/^[a-f0-9]{64}$/.test(disposition.worklogSha256) ||
          !Array.isArray(disposition.errors) || disposition.errors.some((value) => typeof value !== "string") ||
          !Array.isArray(disposition.warnings) || disposition.warnings.some((value) => typeof value !== "string")) {
        throw new Error(`Lane "${id}" verificationDisposition is invalid`);
      }
    }
    for (const value of [id, entry.title, ...entry.aliases]) {
      const key = normalized(value);
      const owner = routed.get(key);
      if (owner && owner !== id) throw new Error(`Lane route "${value}" overlaps Lanes "${owner}" and "${id}"`);
      routed.set(key, id);
    }
  }
  return data;
}

function loadFile(project) {
  const file = laneFile(project);
  try {
    const data = validateFile(JSON.parse(fs.readFileSync(file, "utf8")));
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, lanes: {} };
    if (error instanceof SyntaxError || !error.code) {
      throw new Error(`[AHP_LANES_INVALID] Invalid Lane registry ${file}: ${error.message}. No Lane was selected or changed.`);
    }
    throw explainStoreFsError(error, {
      operation: "read the Lane registry",
      target: file,
      effect: "No Lane was selected or changed."
    });
  }
}

function saveFile(project, data) {
  const file = laneFile(project);
  try {
    writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  } catch (error) {
    throw explainStoreFsError(error, {
      operation: "update the Lane registry",
      target: file,
      effect: "The Lane change did not complete; no worklog record was written."
    });
  }
}

function mutateFile(project, operation, { worklogLock = null } = {}) {
  const lock = path.join(project.dir, ".lanes.lock");
  let token;
  try {
    token = acquireLock(lock);
  } catch (error) {
    throw explainStoreFsError(error, {
      operation: "lock the Lane registry",
      target: lock,
      effect: "No Lane was changed. A live writer is retried briefly; a dead or stale lock is reclaimed automatically."
    });
  }
  let worklogToken;
  try {
    // Status transitions that depend on baton state hold both locks until the
    // registry replacement is published. Writers take only the worklog lock
    // and re-check the status there, which closes archive/start interleavings.
    if (worklogLock) worklogToken = acquireLock(worklogLock);
    const data = loadFile(project);
    const result = operation(data);
    validateFile(data);
    saveFile(project, data);
    return result;
  } finally {
    if (worklogLock) releaseLock(worklogLock, worklogToken);
    releaseLock(lock, token);
  }
}

function enrich(project, id, entry, legacy = false) {
  const dir = legacy ? project.dir : path.join(project.dir, "lanes", id);
  return {
    id,
    title: entry.title ?? id,
    description: entry.description ?? "",
    scope: entry.scope ?? [],
    aliases: entry.aliases ?? [],
    status: entry.status ?? "active",
    created: entry.created ?? null,
    updated: entry.updated ?? null,
    verificationDisposition: entry.verificationDisposition ?? null,
    legacy,
    worklog: legacy ? project.worklog : path.join(dir, "worklog.jsonl"),
    lock: legacy ? project.lock : path.join(dir, ".lock")
  };
}

export function list(project, { includeArchived = false } = {}) {
  const data = loadFile(project);
  const rows = Object.entries(data.lanes)
    .filter(([id]) => id !== LEGACY_LANE_ID)
    .map(([id, entry]) => enrich(project, id, entry));
  if (hasLegacyWorklog(project) || data.lanes[LEGACY_LANE_ID]) {
    rows.unshift(enrich(project, LEGACY_LANE_ID, data.lanes[LEGACY_LANE_ID] ?? LEGACY_LANE_METADATA, true));
  }
  return includeArchived ? rows : rows.filter((lane) => lane.status !== "archived");
}

export function find(project, wanted) {
  const key = normalized(wanted);
  return list(project, { includeArchived: true }).find((lane) =>
    normalized(lane.id) === key ||
    normalized(lane.title) === key ||
    lane.aliases.some((alias) => normalized(alias) === key)
  ) ?? null;
}

export function create(project, { id, title, description, scope = [], aliases = [] }) {
  const laneId = slug(id || title);
  if (!title?.trim()) throw new Error("lane create requires --title");
  if (!description?.trim()) throw new Error("lane create requires --description");
  return mutateFile(project, (data) => {
    const keys = new Set();
    for (const [existingId, entry] of Object.entries(data.lanes)) {
      for (const value of [existingId, entry.title, ...(entry.aliases ?? [])]) keys.add(normalized(value));
    }
    if (hasLegacyWorklog(project)) {
      keys.add(LEGACY_LANE_ID);
      keys.add(normalized(LEGACY_LANE_TITLE));
    }
    for (const value of [laneId, title, ...aliases]) {
      if (keys.has(normalized(value))) {
        throw new Error("Lane \"" + value + "\" overlaps an existing id, title, or alias — choose the existing Lane or edit its aliases");
      }
    }
    const now = new Date().toISOString();
    data.lanes[laneId] = {
      title: title.trim(),
      description: description.trim(),
      scope: [...new Set(scope.map(String))],
      aliases: [...new Set(aliases.map(String))],
      status: "active",
      created: now,
      updated: now
    };
    return enrich(project, laneId, data.lanes[laneId]);
  });
}

export function edit(project, wanted, patch) {
  const current = find(project, wanted);
  if (!current) throw new Error("unknown Lane: " + wanted);
  if (current.legacy && [patch.title, patch.description, patch.scope, patch.aliases].some((value) => value != null)) {
    throw new Error("the synthetic main Lane has fixed identity metadata; only its lifecycle status can be edited");
  }
  return mutateFile(project, (data) => {
    const entry = data.lanes[current.id] ?? { ...LEGACY_LANE_METADATA };
    if (patch.expectedUpdated != null && entry.updated !== patch.expectedUpdated) {
      throw new Error(`Lane "${current.id}" changed concurrently; refusing to overwrite its newer lifecycle state`);
    }
    const candidate = {
      ...entry,
      ...(patch.title != null ? { title: String(patch.title).trim() } : {}),
      ...(patch.description != null ? { description: String(patch.description).trim() } : {}),
      ...(patch.scope != null ? { scope: [...new Set(patch.scope.map(String))] } : {}),
      ...(patch.aliases != null ? { aliases: [...new Set(patch.aliases.map(String))] } : {})
    };
    if (!candidate.title) throw new Error("Lane title cannot be empty");
    if (!candidate.description) throw new Error("Lane description cannot be empty");
    if (patch.operatorDisposition != null && !["done", "archived"].includes(patch.status)) {
      throw new Error("--operator-disposition is valid only while changing a Lane to done or archived");
    }
    if (patch.status != null) {
      if (!LANE_STATUSES.has(patch.status)) throw new Error("lane status must be active | done | archived");
      if (patch.status === "done" || patch.status === "archived") {
        const state = analyze(readEntries(current.worklog));
        if (state.batonHeld) throw new Error(`Lane "${current.id}" holds a baton and cannot become ${patch.status} — end the session first`);
        if (state.openIntents.length) {
          throw new Error(`Lane "${current.id}" has ${state.openIntents.length} open intent(s) and cannot become ${patch.status} — promote or otherwise reconcile them first`);
        }
        const issues = [...state.validation.errors, ...state.validation.warnings];
        if (issues.length) {
          const worklogSha256 = sha256File(current.worklog);
          const existingAccepted = candidate.verificationDisposition?.worklogSha256 === worklogSha256;
          if (patch.operatorDisposition?.trim()) {
            candidate.verificationDisposition = {
              at: new Date().toISOString(),
              reason: patch.operatorDisposition.trim(),
              worklogSha256,
              errors: [...state.validation.errors],
              warnings: [...state.validation.warnings]
            };
          } else if (!existingAccepted) {
            throw new Error(
              `Lane "${current.id}" does not pass strict verification and cannot become ${patch.status}. ` +
              `Run \`ahp verify --lane ${current.id}\`; after operator review, preserve the immutable log and retry with ` +
              `\`--operator-disposition "<reason>"\`.`
            );
          }
        } else if (patch.operatorDisposition?.trim()) {
          throw new Error("--operator-disposition is unnecessary because this Lane passes strict verification");
        }
      }
      candidate.status = patch.status;
    }
    const otherKeys = new Set();
    for (const [id, other] of Object.entries(data.lanes)) {
      if (id === current.id) continue;
      for (const value of [id, other.title, ...(other.aliases ?? [])]) otherKeys.add(normalized(value));
    }
    if (hasLegacyWorklog(project) && current.id !== LEGACY_LANE_ID) {
      otherKeys.add(LEGACY_LANE_ID);
      otherKeys.add(normalized(LEGACY_LANE_TITLE));
    }
    for (const value of [candidate.title, ...(candidate.aliases ?? [])]) {
      if (otherKeys.has(normalized(value))) throw new Error("Lane \"" + value + "\" overlaps another id, title, or alias");
    }
    candidate.updated = new Date().toISOString();
    data.lanes[current.id] = candidate;
    return enrich(project, current.id, candidate, current.legacy);
  }, { worklogLock: patch.status != null ? current.lock : null });
}

function sha256File(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch (error) {
    if (error.code === "ENOENT") bytes = Buffer.alloc(0);
    else throw error;
  }
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function formatChoices(lanes, { heading = "Lane selection is ambiguous:" } = {}) {
  const lines = [heading];
  lanes.forEach((lane, index) => {
    lines.push(`  ${index + 1}. ${lane.id} — ${lane.title} [${lane.status}]`);
    if (lane.description) lines.push(`     ${lane.description.slice(0, 120)}`);
    if (lane.scope.length) lines.push(`     scope: ${lane.scope.join(", ").slice(0, 120)}`);
    if (lane.aliases.length) lines.push(`     aliases: ${lane.aliases.join(", ").slice(0, 120)}`);
  });
  lines.push(`  ${lanes.length + 1}. Create a new Lane`);
  if (lanes.some((lane) => lane.status === "done")) {
    lines.push("A done Lane reopens only through an explicit `ahp start --lane <id>`.");
  }
  if (lanes.some((lane) => lane.status === "blocked")) {
    lines.push("A legacy blocked Lane must first be edited to active or done.");
  }
  lines.push("Use task context to choose with --lane <id>, or create a Lane when none matches; ask the operator only if genuinely uncertain.");
  return lines.join("\n");
}
