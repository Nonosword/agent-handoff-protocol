#!/usr/bin/env node
// End-to-end tests for ahp. Zero dependencies. Creates throwaway Git repos and a
// throwaway AHP_HOME under the OS temp dir.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AHP = path.join(REPO, "bin", "ahp");
const MCP = path.join(REPO, "bin", "ahp-mcp");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ahp-test-"));
const HOME = path.join(TMP, "store");
const ENV = { ...process.env, AHP_HOME: HOME, AHP_WORKER_ID: "", AHP_MODEL: "", AHP_RUNTIME: "" };

let pass = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { failed += 1; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, env: ENV, encoding: "utf8", shell: false });
  return { code: r.status ?? -1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
const ahp = (args, cwd) => sh(process.execPath, [AHP, ...args], cwd);

function mkrepo(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  sh("git", ["init", "-q", "-b", "main"], dir);
  sh("git", ["config", "user.email", "t@t"], dir);
  sh("git", ["config", "user.name", "t"], dir);
  fs.writeFileSync(path.join(dir, "README"), name);
  sh("git", ["add", "-A"], dir);
  sh("git", ["commit", "-qm", "init"], dir);
  return dir;
}
function commit(dir, msg) {
  fs.appendFileSync(path.join(dir, "README"), `\n${msg}`);
  sh("git", ["add", "-A"], dir);
  sh("git", ["commit", "-qm", msg], dir);
  return sh("git", ["rev-parse", "--short", "HEAD"], dir).out;
}

// ---------------------------------------------------------------------------

const A = mkrepo("projA");
const B = mkrepo("projB");

test("status on a fresh project auto-registers and reports empty", () => {
  const r = ahp(["status"], A);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /auto-registered/);
  assert.match(r.out, /worklog\s+empty/);
});

test("start requires --plan and --gate", () => {
  assert.equal(ahp(["start"], A).code, 1);
  assert.equal(ahp(["start", "--plan", "x"], A).code, 1);
});

test("full cycle: start -> intent open -> promote -> end", () => {
  assert.equal(ahp(["start", "--plan", "feature X", "--gate", "pass", "--evidence", "2 tests", "--worker-id", "w1", "--model", "codex"], A).code, 0);
  assert.equal(ahp(["intent", "open", "--id", "i-1", "--title", "core", "--intended", "do it"], A).code, 0);
  const sha = commit(A, "feat: core");
  assert.equal(ahp(["intent", "promote", "--id", "i-1", "--commit", sha, "--gate", "pass", "--actual", "done", "--landmine", "no docs", "--next", "docs"], A).code, 0);
  const end = ahp(["end", "--reason", "limit", "--summary", "1 commit", "--gate", "pass", "--evidence", "3 tests"], A);
  assert.equal(end.code, 0, end.err);
});

test("verify passes for the produced worklog", () => {
  const r = ahp(["verify"], A);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /4 record\(s\), 1 promoted/);
});

test("project B worklog is isolated from A", () => {
  assert.match(ahp(["status"], B).out, /worklog\s+empty/);
  const pathA = ahp(["path"], A).out;
  const pathB = ahp(["path"], B).out;
  assert.notEqual(pathA, pathB);
  assert.match(ahp(["project", "list"], A).out, /projA[\s\S]*projB/);
});

test("the project repo is never modified", () => {
  assert.equal(sh("git", ["status", "--porcelain"], A).out, "");
  assert.ok(!fs.existsSync(path.join(A, ".coworker")));
});

test("pickup shows commits since base and reconciles them", () => {
  const r = ahp(["pickup"], A);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Commits since .* → HEAD/);
  assert.match(r.out, /feat: core.*i-1/s);
  assert.match(r.out, /session ended cleanly \(limit\)/);
});

test("double promote is refused", () => {
  const r = ahp(["intent", "promote", "--id", "i-1", "--commit", "abc1234", "--gate", "pass", "--actual", "again"], A);
  assert.equal(r.code, 1);
  assert.match(r.err, /already promoted/);
});

test("promote without an open intent is refused", () => {
  const r = ahp(["intent", "promote", "--id", "nope", "--commit", "abc1234", "--gate", "pass", "--actual", "x"], A);
  assert.equal(r.code, 1);
  assert.match(r.err, /no open intent/);
});

test("gate=fail promote requires a landmine", () => {
  ahp(["start", "--plan", "s2", "--gate", "pass", "--evidence", "e"], A);
  ahp(["intent", "open", "--id", "i-2", "--title", "t", "--intended", "i"], A);
  const bad = ahp(["intent", "promote", "--id", "i-2", "--gate", "fail", "--actual", "broke"], A);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /landmine/);
  const good = ahp(["intent", "promote", "--id", "i-2", "--gate", "fail", "--actual", "broke", "--landmine", "3 tests red"], A);
  assert.equal(good.code, 0, good.err);
});

test("end with non-pass gate requires a finding", () => {
  const bad = ahp(["end", "--reason", "blocked", "--summary", "s", "--gate", "fail"], A);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /finding/);
});

test("explicit --project works without cwd detection", () => {
  const r = ahp(["status", "--project", "manual-xyz"], os.tmpdir());
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /manual-xyz/);
});

test("compact archives old sessions and keeps recent + open intents", () => {
  const P = mkrepo("projC");
  for (let i = 0; i < 5; i += 1) {
    ahp(["start", "--plan", `s${i}`, "--gate", "pass", "--evidence", "e"], P);
    ahp(["intent", "open", "--id", `k-${i}`, "--title", "t", "--intended", "i"], P);
    const sha = commit(P, `c${i}`);
    ahp(["intent", "promote", "--id", `k-${i}`, "--commit", sha, "--gate", "pass", "--actual", "d"], P);
    ahp(["end", "--reason", "limit", "--summary", "s", "--gate", "pass", "--evidence", "e"], P);
  }
  const r = ahp(["compact", "--keep", "2"], P);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /archived .* record/);
  const projectDir = path.dirname(ahp(["path"], P).out);
  assert.ok(fs.readdirSync(path.join(projectDir, "archive")).length >= 1);
  assert.equal(ahp(["verify"], P).code, 0);
});

test("MCP server: initialize + tools/list + tools/call", () => {
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ahp_status", arguments: { cwd: A } } }
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const r = spawnSync(process.execPath, [MCP], { input: msgs, env: ENV, encoding: "utf8", shell: false });
  const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  const init = lines.find((l) => l.id === 1);
  const list = lines.find((l) => l.id === 2);
  const call = lines.find((l) => l.id === 3);
  assert.equal(init.result.serverInfo.name, "agent-handoff-protocol");
  assert.equal(list.result.tools.length, 8);
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /project\s+projA/);
});

test("bundled example worklogs still validate", () => {
  for (const f of fs.readdirSync(path.join(REPO, "examples")).filter((n) => n.endsWith(".jsonl"))) {
    const r = sh(process.execPath, [path.join(REPO, "tools", "verify-worklog.mjs"), "--file", path.join(REPO, "examples", f), "--quiet"]);
    assert.equal(r.code, 0, `${f}: ${r.err}`);
  }
});

// ---------------------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
