// Structural + lifecycle validation for an AHP worklog. No VCS access — the Git
// cross-checks are pickup-sequence steps (SPEC §7.1), surfaced by `ahp pickup`.

export const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const GATES = new Set(["pass", "fail", "not-run"]);
export const END_REASONS = new Set(["limit", "task-done", "blocked", "handoff-requested"]);
export const RECORD_TYPES = ["handoff.start", "handoff.end", "intent.open", "intent.promote"];

const REQUIRED = {
  "handoff.start": ["seq", "at", "worker", "continuesFrom", "base", "plan"],
  "handoff.end": ["seq", "at", "worker", "reason", "end", "summary"],
  "intent.open": ["seq", "at", "worker", "intentId", "title", "intended"],
  "intent.promote": ["seq", "at", "worker", "intentId", "commits", "gate", "actual"]
};

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
export function validateRecords(entries) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  for (const { record, no } of entries) {
    if (!RECORD_TYPES.includes(record.type)) { err(`line ${no}: unknown record type ${JSON.stringify(record.type)}`); continue; }
    for (const f of REQUIRED[record.type]) {
      if (!Object.hasOwn(record, f)) err(`line ${no}: ${record.type} missing required field "${f}"`);
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
    if (typeof record.at === "string" && !RFC3339.test(record.at)) warn(`line ${no}: "at" is not an RFC 3339 timestamp: ${record.at}`);

    for (const field of ["base", "end"]) {
      const s = record[field];
      if (s && typeof s === "object") {
        if (!GATES.has(s.gate)) err(`line ${no}: ${record.type}.${field}.gate must be pass | fail | not-run`);
        if (!Object.hasOwn(s, "commit")) err(`line ${no}: ${record.type}.${field} missing "commit"`);
        if (s.gate === "pass" && !s.gateEvidence) warn(`line ${no}: ${record.type}.${field}.gate is "pass" without gateEvidence`);
      }
    }
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
        if (activeHandoff) warn(`line ${no}: handoff.start before the previous handoff.end — expected only after a cutoff`);
        activeHandoff = record;
        break;
      case "handoff.end":
        if (!activeHandoff) err(`line ${no}: handoff.end with no open handoff.start`);
        activeHandoff = null;
        break;
      case "intent.open":
        if (opened.has(record.intentId)) err(`line ${no}: intent "${record.intentId}" opened twice`);
        opened.set(record.intentId, no);
        break;
      case "intent.promote":
        if (!opened.has(record.intentId)) err(`line ${no}: intent.promote for "${record.intentId}" with no prior intent.open`);
        if (promoted.has(record.intentId)) err(`line ${no}: intent "${record.intentId}" promoted twice`);
        promoted.add(record.intentId);
        break;
    }
  }

  const stillOpen = [...opened.keys()].filter((id) => !promoted.has(id));
  if (stillOpen.length > 0) {
    warn(`${stillOpen.length} intent(s) open and not promoted: ${stillOpen.join(", ")} — inspect the working tree for matching uncommitted work`);
  }
  if (activeHandoff) {
    const w = typeof activeHandoff.worker === "string" ? activeHandoff.worker : activeHandoff.worker?.id ?? "?";
    warn(`log ends mid-session (worker "${w}" wrote no handoff.end) — reconstruct state per SPEC §7.1 steps 2-4`);
  }
  const lastEnd = [...entries].reverse().find((x) => x.record.type === "handoff.end");
  if (lastEnd && lastEnd.record.end?.gate && lastEnd.record.end.gate !== "pass" && !(Array.isArray(lastEnd.record.findings) && lastEnd.record.findings.length > 0)) {
    err(`line ${lastEnd.no}: handoff.end with a non-pass gate must explain it in findings[]`);
  }

  return {
    errors,
    warnings,
    stats: {
      records: entries.length,
      promoted: promoted.size,
      open: stillOpen.length,
      openIntentIds: stillOpen,
      activeHandoff
    }
  };
}
