// Structural + lifecycle validation for an AHP worklog. No VCS access — the Git
// cross-checks are pickup-sequence steps (SPEC §7.1), surfaced by `ahp pickup`.

import { canonicalWorkerId } from "./worker-detect.mjs";

export const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const GATES = new Set(["pass", "fail", "not-run"]);
export const END_REASONS = new Set(["limit", "task-done", "blocked", "handoff-requested"]);
export const RECORD_TYPES = ["handoff.start", "handoff.end", "intent.open", "intent.promote"];

export const REQUIRED = {
  "handoff.start": ["seq", "at", "worker", "continuesFrom", "base", "plan"],
  "handoff.end": ["seq", "at", "worker", "reason", "end", "summary"],
  "intent.open": ["seq", "at", "worker", "intentId", "title", "intended"],
  "intent.promote": ["seq", "at", "worker", "intentId", "commits", "gate", "actual"]
};

const workerLabel = (w) => (typeof w === "string" ? w : w?.id ?? "?");
// Ownership honours an explicit worker id before model/runtime aliases. Normal
// CLI records already store the canonical id; this also keeps historic logs
// that used a per-worker id plus a model annotation internally consistent.
const ownerWorkerId = (w) => canonicalWorkerId(isObject(w) && typeof w.id === "string" ? w.id : w);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";

function validateText(record, field, no, err, { required = false, maxLength = null, nonEmpty = true } = {}) {
  if (!Object.hasOwn(record, field)) {
    if (required) err(`line ${no}: missing required field "${field}"`);
    return;
  }
  if (typeof record[field] !== "string" || (nonEmpty && !record[field].trim())) err(`line ${no}: "${field}" must be a ${nonEmpty ? "non-empty " : ""}string`);
  else if (maxLength && record[field].length > maxLength) err(`line ${no}: "${field}" must be at most ${maxLength} characters`);
}

function validateStringArray(record, field, no, err, { nonEmptyItems = false } = {}) {
  if (!Object.hasOwn(record, field)) return;
  if (!Array.isArray(record[field]) || record[field].some((value) => typeof value !== "string" || (nonEmptyItems && !value.trim()))) {
    err(`line ${no}: "${field}" must be an array of ${nonEmptyItems ? "non-empty " : ""}strings`);
  }
}

function validateWorker(record, no, err) {
  const value = record.worker;
  if (typeof value === "string") {
    if (!value.trim() || value.length > 120) err(`line ${no}: "worker" must be a non-empty string of at most 120 characters`);
    return;
  }
  if (!isObject(value) || !isText(value.id) || value.id.length > 120) {
    err(`line ${no}: "worker" must be a non-empty string or an object with a non-empty string id`);
    return;
  }
  for (const field of ["model", "runtime"]) {
    if (Object.hasOwn(value, field) && (typeof value[field] !== "string" || value[field].length > 120)) {
      err(`line ${no}: worker.${field} must be a string of at most 120 characters`);
    }
  }
}

function validateState(record, field, no, err, warn) {
  const state = record[field];
  if (!isObject(state)) { err(`line ${no}: ${record.type}.${field} must be an object`); return; }
  if (!isText(state.commit) || state.commit.length > 200) err(`line ${no}: ${record.type}.${field}.commit must be a non-empty string of at most 200 characters`);
  if (!GATES.has(state.gate)) err(`line ${no}: ${record.type}.${field}.gate must be pass | fail | not-run`);
  if (typeof state.treeClean !== "boolean") err(`line ${no}: ${record.type}.${field}.treeClean must be boolean`);
  if (Object.hasOwn(state, "gateEvidence") && typeof state.gateEvidence !== "string") err(`line ${no}: ${record.type}.${field}.gateEvidence must be a string`);
  if (Object.hasOwn(state, "verifiedBy") && typeof state.verifiedBy !== "string") err(`line ${no}: ${record.type}.${field}.verifiedBy must be a string`);
  if (state.gate === "pass" && !state.gateEvidence) warn(`line ${no}: ${record.type}.${field}.gate is "pass" without gateEvidence`);
}

// Parse JSONL text -> [{ record, no }]. Throws on a malformed line so callers
// can decide to stop (SPEC §8: do not append after a corrupt line).
export function parseJsonl(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let record;
    try { record = JSON.parse(line); }
    catch { const e = new Error(`line ${i + 1}: not valid JSON`); e.line = i + 1; throw e; }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      const e = new Error(`line ${i + 1}: record is not a JSON object`); e.line = i + 1; throw e;
    }
    out.push({ record, no: i + 1 });
  }
  return out;
}

// entries: [{ record, no }] from parseJsonl. Returns { errors, warnings, stats }.
// Three tiers:
//   errors   — the log is malformed or a lifecycle rule is broken. Always fatal.
//   warnings — the log is well-formed but has a quality problem (bad timestamp,
//              a `pass` gate with no evidence, a baton not self-verified).
//              `ahp verify` fails on these by default; `--lenient` downgrades them.
//   notes    — expected, valid situations worth pointing at (a hard cutoff, an
//              open intent mid-work). Never fatal, in any mode.
export function validateRecords(entries) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  const note = (m) => notes.push(m);

  for (const { record, no } of entries) {
    if (!RECORD_TYPES.includes(record.type)) { err(`line ${no}: unknown record type ${JSON.stringify(record.type)}`); continue; }
    for (const f of REQUIRED[record.type]) {
      if (!Object.hasOwn(record, f)) err(`line ${no}: ${record.type} missing required field "${f}"`);
    }
    validateWorker(record, no, err);
    validateText(record, "sessionId", no, err, { maxLength: 120, nonEmpty: false });
    if (record.type === "handoff.start") {
      if (record.continuesFrom !== null && (!Number.isSafeInteger(record.continuesFrom) || record.continuesFrom < 1)) err(`line ${no}: "continuesFrom" must be null or an integer >= 1`);
      validateText(record, "plan", no, err, { required: true });
      validateState(record, "base", no, err, warn);
    }
    if (record.type === "handoff.end") {
      validateText(record, "summary", no, err, { required: true });
      validateState(record, "end", no, err, warn);
      validateStringArray(record, "openIntents", no, err);
      validateStringArray(record, "findings", no, err);
    }
    if (record.type === "intent.open") {
      if (typeof record.intentId !== "string" || !/^[A-Za-z0-9._-]+$/.test(record.intentId) || record.intentId.length > 80) err(`line ${no}: "intentId" must match [A-Za-z0-9._-]+ and be at most 80 characters`);
      validateText(record, "title", no, err, { required: true });
      validateText(record, "intended", no, err, { required: true });
      validateStringArray(record, "refs", no, err);
      validateStringArray(record, "scope", no, err);
    }
    if (record.type === "intent.promote") {
      if (typeof record.intentId !== "string" || !/^[A-Za-z0-9._-]+$/.test(record.intentId) || record.intentId.length > 80) err(`line ${no}: "intentId" must match [A-Za-z0-9._-]+ and be at most 80 characters`);
      validateStringArray(record, "commits", no, err, { nonEmptyItems: true });
      validateText(record, "actual", no, err, { required: true });
      validateStringArray(record, "landmines", no, err);
      validateText(record, "next", no, err, { nonEmpty: false });
    }
  }

  let prevSeq = 0;
  for (const { record, no } of entries) {
    if (!RECORD_TYPES.includes(record.type)) continue;
    if (!Number.isSafeInteger(record.seq) || record.seq <= prevSeq) {
      err(`line ${no}: seq must be a strictly increasing integer (got ${JSON.stringify(record.seq)} after ${prevSeq})`);
    } else {
      prevSeq = record.seq;
    }
    if (typeof record.at !== "string") err(`line ${no}: "at" must be a string`);
    else if (!RFC3339.test(record.at)) warn(`line ${no}: "at" is not an RFC 3339 timestamp: ${record.at}`);

    if (record.type === "handoff.start" && record.base?.verifiedBy && record.base.verifiedBy !== "self") {
      warn(`line ${no}: base.verifiedBy is "${record.base.verifiedBy}" — the worker must verify the baton itself (SPEC §7.1.5)`);
    }
    if (record.type === "handoff.end" && !END_REASONS.has(record.reason)) {
      err(`line ${no}: handoff.end reason must be ${[...END_REASONS].join(" | ")}`);
    }
    if (record.type === "intent.promote") {
      if (!GATES.has(record.gate)) err(`line ${no}: intent.promote gate must be pass | fail | not-run`);
      if (Array.isArray(record.commits) && record.commits.length === 0 && record.gate !== "fail") {
        err(`line ${no}: intent.promote must name at least one commit unless gate is "fail"`);
      }
      if (record.gate === "fail" && !(Array.isArray(record.landmines) && record.landmines.length > 0)) {
        err(`line ${no}: intent.promote with gate "fail" must list landmines`);
      }
    }
  }

  const opened = new Map();
  const promoted = new Set();
  let activeHandoff = null;
  for (const { record, no } of entries) {
    switch (record.type) {
      case "handoff.start":
        if (activeHandoff) {
          const w = workerLabel(activeHandoff.worker);
          note(`line ${no}: baton severed — the session that started at seq ${activeHandoff.seq} (${w}) wrote no handoff.end before this one. A hard cutoff; SPEC §7.1 recovers it. If you are picking up, run \`ahp pickup\` and reconcile against HEAD before writing.`);
        }
        activeHandoff = record;
        break;
      case "handoff.end":
        if (!activeHandoff) err(`line ${no}: handoff.end with no open handoff.start`);
        else if (ownerWorkerId(record.worker) !== ownerWorkerId(activeHandoff.worker)) err(`line ${no}: handoff.end worker must own the active baton (${workerLabel(activeHandoff.worker)})`);
        activeHandoff = null;
        break;
      case "intent.open":
        if (!activeHandoff) err(`line ${no}: intent.open "${record.intentId}" with no baton held`);
        else if (ownerWorkerId(record.worker) !== ownerWorkerId(activeHandoff.worker)) err(`line ${no}: intent.open worker must own the active baton (${workerLabel(activeHandoff.worker)})`);
        if (opened.has(record.intentId)) err(`line ${no}: intent "${record.intentId}" opened twice`);
        opened.set(record.intentId, no);
        break;
      case "intent.promote":
        if (!activeHandoff) err(`line ${no}: intent.promote "${record.intentId}" with no baton held`);
        else if (ownerWorkerId(record.worker) !== ownerWorkerId(activeHandoff.worker)) err(`line ${no}: intent.promote worker must own the active baton (${workerLabel(activeHandoff.worker)})`);
        if (!opened.has(record.intentId)) err(`line ${no}: intent.promote for "${record.intentId}" with no prior intent.open`);
        if (promoted.has(record.intentId)) err(`line ${no}: intent "${record.intentId}" promoted twice`);
        promoted.add(record.intentId);
        break;
    }
  }

  const stillOpen = [...opened.keys()].filter((id) => !promoted.has(id));
  if (stillOpen.length > 0) {
    note(`${stillOpen.length} intent(s) open and not promoted: ${stillOpen.join(", ")} — inspect the working tree for matching uncommitted work`);
  }
  if (activeHandoff) {
    note(`log ends mid-session (${workerLabel(activeHandoff.worker)} wrote no handoff.end) — best-effort end is optional; SPEC §7.1 steps 2-4 reconstruct state`);
  }
  for (const { record, no } of entries) {
    if (record.type === "handoff.end" && record.end?.gate && record.end.gate !== "pass" && !(Array.isArray(record.findings) && record.findings.length > 0)) {
      err(`line ${no}: handoff.end with a non-pass gate must explain it in findings[]`);
    }
  }

  return {
    errors,
    warnings,
    notes,
    stats: {
      records: entries.length,
      promoted: promoted.size,
      open: stillOpen.length,
      openIntentIds: stillOpen,
      activeHandoff
    }
  };
}
