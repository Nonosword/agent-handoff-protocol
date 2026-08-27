#!/usr/bin/env node
// verify-worklog — reference validator for the Agent Handoff Protocol (AHP).
//
// Checks a .coworker/worklog.jsonl stream for:
//   - JSON Lines shape (one object per line)
//   - required fields per record type (SPEC.md §5)
//   - seq strictly increasing (SPEC.md §4.2)
//   - intent lifecycle (SPEC.md §6): promote needs a prior open; no double
//     open/promote; a fail-gate promote lists landmines
//   - handoff pairing: end needs a start; a non-pass end carries findings
//   - reports intents left open (the pointer to unfinished work)
//
// It does NOT consult version control — the git cross-checks are pickup-sequence
// steps a worker runs directly (SPEC.md §7.1 steps 2-3).
//
// Zero dependencies. Node >= 18.
//
// Usage:
//   verify-worklog [--file <path>] [--root <dir>] [--strict] [--quiet]
//
//   --file    path to the worklog (default: <root>/.coworker/worklog.jsonl)
//   --root    repository root (default: current directory)
//   --strict  treat warnings as errors
//   --quiet   only print on error
//   env AHP_WORKLOG overrides the default path
//
// Exit codes: 0 = ok (or absent, or warnings without --strict)
//             1 = structural / lifecycle error
//             2 = usage error

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let file = process.env.AHP_WORKLOG ?? null;
let root = process.cwd();
let strict = false;
let quiet = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--file") { file = args[++i]; }
  else if (arg === "--root") { root = args[++i]; }
  else if (arg === "--strict") { strict = true; }
  else if (arg === "--quiet") { quiet = true; }
  else if (arg === "-h" || arg === "--help") { printHelp(); process.exit(0); }
  else { process.stderr.write(`unknown argument: ${arg}\n`); process.exit(2); }
}
if (file === undefined) { process.stderr.write("--file requires a value\n"); process.exit(2); }
if (root === undefined) { process.stderr.write("--root requires a value\n"); process.exit(2); }

const worklogPath = file ?? path.join(root, ".coworker", "worklog.jsonl");

function printHelp() {
  process.stdout.write(
    "verify-worklog — AHP worklog validator\n\n" +
    "  --file <path>   worklog path (default <root>/.coworker/worklog.jsonl)\n" +
    "  --root <dir>    repository root (default cwd)\n" +
    "  --strict        warnings become errors\n" +
    "  --quiet         print only on error\n"
  );
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const GATES = new Set(["pass", "fail", "not-run"]);
const END_REASONS = new Set(["limit", "task-done", "blocked", "handoff-requested"]);
const REQUIRED = {
  "handoff.start": ["seq", "at", "worker", "continuesFrom", "base", "plan"],
  "handoff.end": ["seq", "at", "worker", "reason", "end", "summary"],
  "intent.open": ["seq", "at", "worker", "intentId", "title", "intended"],
  "intent.promote": ["seq", "at", "worker", "intentId", "commits", "gate", "actual"]
};

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

let raw;
try {
  raw = fs.readFileSync(worklogPath, "utf8");
} catch (error) {
  if (error.code === "ENOENT") {
    if (!quiet) process.stdout.write(`worklog absent (${rel(worklogPath)}) — treated as a fresh start.\n`);
    process.exit(0);
  }
  process.stderr.write(`cannot read ${rel(worklogPath)}: ${error.message}\n`);
  process.exit(2);
}

function rel(p) {
  const r = path.relative(root, p);
  return r.startsWith("..") ? p : r;
}

const lines = raw.split("\n").map((line, i) => ({ line, no: i + 1 })).filter((x) => x.line.trim() !== "");
const records = [];
for (const { line, no } of lines) {
  let rec;
  try { rec = JSON.parse(line); }
  catch { err(`line ${no}: not valid JSON`); continue; }
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) { err(`line ${no}: record must be a JSON object`); continue; }
  if (!Object.hasOwn(REQUIRED, rec.type)) { err(`line ${no}: unknown record type ${JSON.stringify(rec.type)}`); continue; }
  for (const f of REQUIRED[rec.type]) {
    if (!Object.hasOwn(rec, f)) err(`line ${no}: ${rec.type} missing required field "${f}"`);
  }
  records.push({ rec, no });
}

let prevSeq = 0;
for (const { rec, no } of records) {
  if (!Number.isSafeInteger(rec.seq) || rec.seq <= prevSeq) {
    err(`line ${no}: seq must be a strictly increasing integer (got ${JSON.stringify(rec.seq)} after ${prevSeq})`);
  } else {
    prevSeq = rec.seq;
  }
  if (typeof rec.at === "string" && !RFC3339.test(rec.at)) warn(`line ${no}: "at" is not an RFC 3339 timestamp: ${rec.at}`);

  for (const stateField of ["base", "end"]) {
    const s = rec[stateField];
    if (s && typeof s === "object") {
      if (!GATES.has(s.gate)) err(`line ${no}: ${rec.type}.${stateField}.gate must be pass | fail | not-run`);
      if (!Object.hasOwn(s, "commit")) err(`line ${no}: ${rec.type}.${stateField} missing "commit"`);
      if (typeof s.treeClean !== "boolean") warn(`line ${no}: ${rec.type}.${stateField}.treeClean should be a boolean`);
      if (s.gate === "pass" && !s.gateEvidence) warn(`line ${no}: ${rec.type}.${stateField}.gate is "pass" without gateEvidence`);
    }
  }

  if (rec.type === "handoff.start" && rec.base?.verifiedBy && rec.base.verifiedBy !== "self") {
    warn(`line ${no}: base.verifiedBy is "${rec.base.verifiedBy}" — the worker must verify the baton itself (SPEC §7.1.5)`);
  }
  if (rec.type === "handoff.end" && !END_REASONS.has(rec.reason)) {
    err(`line ${no}: handoff.end reason must be ${[...END_REASONS].join(" | ")}`);
  }
  if (rec.type === "intent.promote") {
    if (!GATES.has(rec.gate)) err(`line ${no}: intent.promote gate must be pass | fail | not-run`);
    if (Array.isArray(rec.commits) && rec.commits.length === 0 && rec.gate !== "fail") {
      err(`line ${no}: intent.promote must name at least one commit unless gate is "fail"`);
    }
    if (rec.gate === "fail" && !(Array.isArray(rec.landmines) && rec.landmines.length > 0)) {
      err(`line ${no}: intent.promote with gate "fail" must list landmines`);
    }
  }
}

// Lifecycle / pairing.
const opened = new Map();
const promoted = new Set();
let activeHandoff = null;
for (const { rec, no } of records) {
  switch (rec.type) {
    case "handoff.start":
      if (activeHandoff) {
        warn(`line ${no}: handoff.start before the previous handoff.end — expected only after a cutoff`);
      }
      activeHandoff = rec;
      break;
    case "handoff.end":
      if (!activeHandoff) err(`line ${no}: handoff.end with no open handoff.start`);
      activeHandoff = null;
      break;
    case "intent.open":
      if (opened.has(rec.intentId)) err(`line ${no}: intent "${rec.intentId}" opened twice`);
      opened.set(rec.intentId, no);
      break;
    case "intent.promote":
      if (!opened.has(rec.intentId)) err(`line ${no}: intent.promote for "${rec.intentId}" with no prior intent.open`);
      if (promoted.has(rec.intentId)) err(`line ${no}: intent "${rec.intentId}" promoted twice`);
      promoted.add(rec.intentId);
      break;
  }
}

const stillOpen = [...opened.keys()].filter((id) => !promoted.has(id));
if (stillOpen.length > 0) {
  warn(`${stillOpen.length} intent(s) open and not promoted: ${stillOpen.join(", ")} — on pickup, inspect the working tree for matching uncommitted work`);
}
if (activeHandoff) {
  const w = typeof activeHandoff.worker === "string" ? activeHandoff.worker : activeHandoff.worker?.id ?? "?";
  warn(`log ends mid-session (worker "${w}" wrote no handoff.end) — reconstruct state per SPEC §7.1 steps 2-4`);
}
const lastEnd = [...records].reverse().find((x) => x.rec.type === "handoff.end");
if (lastEnd && lastEnd.rec.end?.gate && lastEnd.rec.end.gate !== "pass" && !(Array.isArray(lastEnd.rec.findings) && lastEnd.rec.findings.length > 0)) {
  err(`line ${lastEnd.no}: handoff.end with a non-pass gate must explain it in findings[]`);
}

if (!quiet) for (const w of warnings) process.stdout.write(`warning: ${w}\n`);
const promotedToErrors = strict ? warnings : [];
const allErrors = [...errors, ...promotedToErrors.map((w) => `(strict) ${w}`)];

if (allErrors.length > 0) {
  for (const e of allErrors) process.stderr.write(`error: ${e}\n`);
  process.exit(1);
}
if (!quiet) {
  process.stdout.write(`ok: ${records.length} record(s), ${promoted.size} promoted intent(s), ${stillOpen.length} open, ${warnings.length} warning(s)\n`);
}
process.exit(0);
