// Lifecycle rules for the worklog: the baton projection, and the preconditions
// each write must satisfy. One authority, so the CLI — and anything else that
// ever appends (today only the CLI; the MCP server shells out to it) — agree on
// when a record is allowed, and derive "who holds the baton" the same way.

import { canonicalWorkerId } from "./worker-detect.mjs";

// A session id: <canonical-worker>-<yyyymmdd>-<seq of the handoff.start>.
// Human-readable and greppable; no dependency, no opaque id.
export function makeSessionId(worker, at, seq) {
  const day = String(at ?? "").slice(0, 10).replace(/-/g, "") || "00000000";
  return `${canonicalWorkerId(worker)}-${day}-${seq}`;
}

// --- baton projection ------------------------------------------------------

// Fold the record stream into what a pickup / status / dashboard view needs.
// `baton` is the single snapshot every surface reads instead of re-folding the
// events: { sessionId, worker, phase: held|released, sinceSeq, since }.
export function project(records) {
  let lastStart = null;
  let batonHeld = false;
  let batonWorker = null;
  const promotes = [];
  const promotedCommits = new Set();

  for (const r of records) {
    if (r.type === "handoff.start") { lastStart = r; batonHeld = true; batonWorker = r.worker; }
    else if (r.type === "handoff.end") { batonHeld = false; }
    else if (r.type === "intent.promote") {
      promotes.push(r);
      for (const c of r.commits ?? []) promotedCommits.add(c);
    }
  }
  const promotedIds = new Set(promotes.map((p) => p.intentId));
  const openIntents = records.filter((r) => r.type === "intent.open" && !promotedIds.has(r.intentId));

  const baton = lastStart
    ? {
        sessionId: lastStart.sessionId ?? makeSessionId(lastStart.worker, lastStart.at, lastStart.seq),
        worker: canonicalWorkerId(lastStart.worker),
        phase: batonHeld ? "held" : "released",
        sinceSeq: lastStart.seq,
        since: lastStart.at ?? null
      }
    : null;

  return { lastStart, batonHeld, batonWorker, baton, openIntents, promotes, promotedCommits: [...promotedCommits] };
}

// The current session's id, for records written while the baton is held so they
// carry their session. Undefined when no baton is held or the start predates
// sessionId (old log) — the field is simply omitted then.
export function currentSessionId({ batonHeld, lastStart }) {
  if (!batonHeld || !lastStart) return undefined;
  return lastStart.sessionId ?? makeSessionId(lastStart.worker, lastStart.at, lastStart.seq);
}

// --- write preconditions -------------------------------------------------

// handoff.start is always allowed — a second start with no end between is a
// hard cutoff, which is normal (SPEC §8). The caller surfaces it as a note.

export function assertCanOpen(records, id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("intent id must match [A-Za-z0-9._-]+");
  if (records.some((r) => r.type === "intent.open" && r.intentId === id)) {
    throw new Error(`intent "${id}" is already open`);
  }
}

export function assertCanPromote(records, { id, gate, commits = [], landmines = [] }) {
  if (gate !== "fail" && commits.length === 0) {
    throw new Error("intent promote requires --commit unless --gate fail");
  }
  if (gate === "fail" && landmines.length === 0) {
    throw new Error("a --gate fail promotion must carry at least one --landmine");
  }
  if (!records.some((r) => r.type === "intent.open" && r.intentId === id)) {
    throw new Error(`no open intent "${id}" — open it first`);
  }
  if (records.some((r) => r.type === "intent.promote" && r.intentId === id)) {
    throw new Error(`intent "${id}" is already promoted`);
  }
}

export function assertCanEnd({ gate, findings = [] }) {
  if (gate !== "pass" && findings.length === 0) {
    throw new Error(`--gate ${gate} at handoff.end requires at least one --finding explaining it`);
  }
}
