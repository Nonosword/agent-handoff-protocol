#!/usr/bin/env node
// verify-worklog — validate an AHP worklog file directly (structural + lifecycle).
//
// For project-aware validation use `ahp verify`. This standalone form takes a
// path and is handy in CI, hooks, or against an archived span.
//
//   node tools/verify-worklog.mjs --file <path> [--strict] [--quiet]
//
// Exit: 0 ok / absent / warnings-without-strict · 1 error · 2 usage.

import fs from "node:fs";
import path from "node:path";
import { parseJsonl, validateRecords } from "../src/validate.mjs";

const args = process.argv.slice(2);
let file = process.env.AHP_WORKLOG ?? null;
let strict = false;
let quiet = false;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--file") file = args[++i];
  else if (a === "--strict") strict = true;
  else if (a === "--quiet") quiet = true;
  else if (a === "-h" || a === "--help") {
    process.stdout.write("usage: verify-worklog --file <path> [--strict] [--quiet]\n");
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

const { errors, warnings, stats } = validateRecords(entries);
if (!quiet) for (const w of warnings) process.stdout.write(`warning: ${w}\n`);
const all = [...errors, ...(strict ? warnings.map((w) => `(strict) ${w}`) : [])];
if (all.length) { for (const e of all) process.stderr.write(`error: ${e}\n`); process.exit(1); }
if (!quiet) process.stdout.write(`ok: ${stats.records} record(s), ${stats.promoted} promoted intent(s), ${stats.open} open, ${warnings.length} warning(s)\n`);
process.exit(0);
