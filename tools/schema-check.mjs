#!/usr/bin/env node
// schema-check — validate worklog records against schema/worklog.schema.json.
//
// Unlike verify-worklog.mjs (zero-dep, structural + lifecycle), this needs ajv.
// It exists so CI can prove the JSON Schema and the examples stay in agreement,
// and so downstream tooling in other languages has a trusted reference result.
//
//   npm install --no-save ajv@8 ajv-formats@3
//   node tools/schema-check.mjs examples/*.jsonl
//
// Exit 0 if every line of every file validates, 1 otherwise, 2 on usage error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write("usage: schema-check <file.jsonl> [file.jsonl ...]\n");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, "..", "schema", "worklog.schema.json");

let Ajv;
let addFormats;
try {
  Ajv = (await import("ajv/dist/2020.js")).default;
  const formatsMod = await import("ajv-formats");
  addFormats = formatsMod.default ?? formatsMod;
} catch {
  process.stderr.write("schema-check needs ajv: npm install --no-save ajv@8 ajv-formats@3\n");
  process.exit(2);
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, "utf8")));

let bad = 0;
let total = 0;
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  lines.forEach((line, i) => {
    total += 1;
    let record;
    try { record = JSON.parse(line); }
    catch { bad += 1; process.stderr.write(`${file}:${i + 1}: not JSON\n`); return; }
    if (!validate(record)) {
      bad += 1;
      process.stderr.write(`${file}:${i + 1}: ${ajv.errorsText(validate.errors)}\n`);
    }
  });
}

if (bad > 0) {
  process.stderr.write(`\nschema-check: ${bad}/${total} record(s) invalid\n`);
  process.exit(1);
}
process.stdout.write(`schema-check: ${total} record(s) valid against worklog.schema.json\n`);
