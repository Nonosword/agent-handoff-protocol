#!/usr/bin/env node
// verify-worklog — validate an AHP worklog file directly (structural + lifecycle).
//
// For project-aware validation use `ahp verify`. This standalone form takes a
// path and is handy in CI, hooks, or against an archived span.
//
//   node tools/verify-worklog.mjs --file <path> [--lenient] [--quiet]
//
// Strict by default: a quality warning is fatal. --lenient downgrades warnings
// to advisory. --strict is still accepted (no-op). Notes are never fatal.
//
// Exit: 0 ok / absent · 1 error (or a warning without --lenient) · 2 usage.

import fs from "node:fs";
import path from "node:path";
import { parseJsonl, validateRecords } from "../src/validate.mjs";

const args = process.argv.slice(2);
let file = process.env.AHP_WORKLOG ?? null;
let lenient = false;
let quiet = false;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--file") file = args[++i];
  else if (a === "--lenient") lenient = true;
  else if (a === "--strict") { /* now the default — accepted for compatibility */ }
  else if (a === "--quiet") quiet = true;
  else if (a === "-h" || a === "--help") {
    process.stdout.write("usage: verify-worklog --file <path> [--lenient] [--quiet]\n");
    process.exit(0);
  } else { process.stderr.write(`unknown argument: ${a}\n`); process.exit(2); }
}
if (!file) { process.stderr.write("--file <path> is required\n"); process.exit(2); }

let text;
try { text = fs.readFileSync(file, "utf8"); }
catch (e) {
  if (e.code === "ENOENT") {
    if (!quiet) process.stdout.write(`worklog absent (${file}) — treated as a fresh start.\n`);
    process.exit(0);
  }
  process.stderr.write(`cannot read ${file}: ${e.message}\n`);
  process.exit(2);
}

let entries;
try { entries = parseJsonl(text); }
catch (e) { process.stderr.write(`error: ${path.basename(file)} ${e.message}\n`); process.exit(1); }

const { errors, warnings, notes, stats } = validateRecords(entries);
if (!quiet) for (const n of notes) process.stdout.write(`note: ${n}\n`);
for (const w of warnings) {
  if (lenient) { if (!quiet) process.stdout.write(`warning: ${w}\n`); }
  else process.stderr.write(`error: ${w}\n`);
}
for (const e of errors) process.stderr.write(`error: ${e}\n`);
if (errors.length || (!lenient && warnings.length)) process.exit(1);
if (!quiet) process.stdout.write(`ok: ${stats.records} record(s), ${stats.promoted} promoted intent(s), ${stats.open} open, ${warnings.length} warning(s), ${notes.length} note(s)\n`);
process.exit(0);
