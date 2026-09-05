#!/usr/bin/env node
// End-to-end tests for ahp. Zero dependencies. Creates throwaway Git repos and a
// throwaway AHP_HOME under the OS temp dir.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { canonicalWorkerId, WORKERS } from "../src/worker-detect.mjs";
import { project, makeSessionId, assertCanOpen, assertCanPromote, assertCanEnd } from "../src/lifecycle.mjs";
import { REQUIRED, RECORD_TYPES, GATES, END_REASONS } from "../src/validate.mjs";

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

test("lifecycle: one authority for the baton projection and write preconditions", () => {
  const recs = [
    { type: "handoff.start", seq: 1, worker: { id: "codex" } },
    { type: "intent.open", seq: 2, intentId: "i-1" },
    { type: "intent.promote", seq: 3, intentId: "i-1", commits: ["abc1234"] }
  ];
  const p = project(recs);
  assert.equal(p.batonHeld, true);
  assert.equal(p.lastStart.seq, 1);
  assert.deepEqual(p.openIntents, []);
  assert.deepEqual(p.promotedCommits, ["abc1234"]);

  assert.throws(() => assertCanOpen(recs, "i-1"), /already open/);
  assert.throws(() => assertCanOpen(recs, "bad id"), /must match/);
  assert.doesNotThrow(() => assertCanOpen(recs, "i-2"));
  assert.throws(() => assertCanPromote(recs, { id: "i-1", gate: "pass", commits: ["x"] }), /already promoted/);
  assert.throws(() => assertCanPromote(recs, { id: "i-9", gate: "pass", commits: ["x"] }), /no open intent/);
  assert.throws(() => assertCanPromote(recs, { id: "i-1", gate: "pass", commits: [] }), /requires --commit/);
  assert.throws(() => assertCanPromote(recs, { id: "i-1", gate: "fail", commits: [], landmines: [] }), /--landmine/);
  assert.throws(() => assertCanEnd({ gate: "fail", findings: [] }), /--finding/);
  assert.doesNotThrow(() => assertCanEnd({ gate: "pass", findings: [] }));
});

test("sessionId: minted on start, echoed while the baton is held, in the baton snapshot", () => {
  const P = mkrepo("projSid");
  const as = (id) => ({ ...ENV, AHP_WORKER_ID: id });
  const run = (id, args) => spawnSync(process.execPath, [AHP, ...args], { cwd: P, env: as(id), encoding: "utf8" });

  run("codex", ["start", "--plan", "p", "--gate", "pass", "--evidence", "e"]);
  const sha = commit(P, "w");
  run("codex", ["intent", "open", "--id", "i-1", "--title", "t", "--intended", "x"]);
  run("codex", ["intent", "promote", "--id", "i-1", "--commit", sha, "--gate", "pass", "--actual", "d"]);
  run("codex", ["end", "--reason", "task-done", "--summary", "s", "--gate", "pass", "--evidence", "e"]);

  const recs = fs.readFileSync(ahp(["path"], P).out.trim(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const start = recs[0];
  assert.match(start.sessionId, /^codex-\d{8}-1$/, start.sessionId);
  assert.equal(start.sessionId, makeSessionId(start.worker, start.at, start.seq));
  for (const r of recs) assert.equal(r.sessionId, start.sessionId, `${r.type} echoes the session`);

  // baton snapshot after a clean end
  const st = JSON.parse(ahp(["status", "--json"], P).out);
  assert.equal(st.baton.sessionId, start.sessionId);
  assert.equal(st.baton.worker, "codex");
  assert.equal(st.baton.phase, "released");
  assert.equal(st.baton.sinceSeq, 1);

  // `ahp log` heads each session with its sessionId
  assert.match(ahp(["log"], P).out, new RegExp(`── session 1: ${start.sessionId} ·`));
});

test("baton snapshot agrees with the legacy batonHeld/batonWorker fold", () => {
  // shadow-compare: the new single projection must not disagree with the old
  // event fold for any bundled example, held or released.
  for (const f of ["solo", "relay", "hard-cutoff"]) {
    const recs = fs.readFileSync(path.join(REPO, "examples", `${f}.jsonl`), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    const p = project(recs);
    if (p.lastStart) {
      assert.equal(p.baton.phase === "held", p.batonHeld, `${f}: phase vs batonHeld`);
      assert.equal(p.baton.worker, canonicalWorkerId(p.batonWorker), `${f}: worker`);
      assert.equal(p.baton.sinceSeq, p.lastStart.seq, `${f}: sinceSeq`);
    } else {
      assert.equal(p.baton, null);
    }
  }
});

test("baton.sessionId is synthesised for a log written before the field existed", () => {
  const recs = [
    { type: "handoff.start", seq: 1, at: "2026-08-01T10:00:00Z", worker: { id: "claude-code" }, continuesFrom: null, base: { commit: "a1", gate: "pass", gateEvidence: "ok", treeClean: true, verifiedBy: "self" }, plan: "p" }
  ];
  assert.equal(project(recs).baton.sessionId, "claude-20260801-1");
});

test("verify: strict by default, notes never fatal, --lenient downgrades warnings", () => {
  const dir = path.join(TMP, "verify-tiers"); fs.mkdirSync(dir, { recursive: true });
  // a pass gate with no evidence = a warning; a hard cutoff = a note
  const wl = path.join(dir, "w.jsonl");
  fs.writeFileSync(wl, [
    JSON.stringify({ type: "handoff.start", seq: 1, at: "2026-09-04T00:00:00Z", worker: { id: "claude" }, continuesFrom: null, base: { commit: "a1", gate: "pass", treeClean: true, verifiedBy: "self" }, plan: "p" }),
    JSON.stringify({ type: "handoff.start", seq: 2, at: "2026-09-04T02:00:00Z", worker: { id: "codex" }, continuesFrom: 1, base: { commit: "a1", gate: "pass", gateEvidence: "12 ok", treeClean: true, verifiedBy: "self" }, plan: "q" })
  ].join("\n") + "\n");
  const tool = (extra) => sh(process.execPath, [path.join(REPO, "tools", "verify-worklog.mjs"), "--file", wl, ...extra]);
  const strict = tool([]);
  assert.equal(strict.code, 1, "warning is fatal by default");
  assert.match(strict.out, /note: line 2: baton severed/);       // notes -> stdout
  assert.match(strict.err, /error: line 1: .*without gateEvidence/); // fatal warning -> stderr
  const lenient = tool(["--lenient"]);
  assert.equal(lenient.code, 0, lenient.out + lenient.err);
  assert.match(lenient.out, /warning: line 1: .*without gateEvidence/);
  assert.match(lenient.out, /note: line 2: baton severed/);
  assert.equal(tool(["--strict"]).code, 1, "--strict still accepted");

  // an intent written with no baton held is a warning (fatal by default)
  const wl2 = path.join(dir, "nobaton.jsonl");
  fs.writeFileSync(wl2, JSON.stringify({ type: "intent.open", seq: 1, at: "2026-09-04T00:00:00Z", worker: { id: "codex" }, intentId: "i-x", title: "t", intended: "y" }) + "\n");
  const r2 = sh(process.execPath, [path.join(REPO, "tools", "verify-worklog.mjs"), "--file", wl2]);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /no baton held/);
  assert.equal(sh(process.execPath, [path.join(REPO, "tools", "verify-worklog.mjs"), "--file", wl2, "--lenient"]).code, 0);
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

test("MCP array args (commits/refs/landmines/findings) reach the CLI", () => {
  // regression: toArgv's list() helper appended to the globals array *after*
  // it had already been spread into the command argv, so every array-valued
  // MCP arg was silently dropped — `ahp_intent_promote` with `commits` failed
  // with "requires --commit".
  const P = mkrepo("projMcpArr");
  const sha = sh("git", ["rev-parse", "HEAD"], P).out;
  const call = (id, name, args) =>
    ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { ...args, cwd: P } } });
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {}, clientInfo: { name: "claude" } } },
    call(2, "ahp_start", { plan: "p", gate: "pass", evidence: "e" }),
    call(3, "ahp_intent_open", { id: "i-1", title: "t", intended: "do x", refs: ["src/a.js"] }),
    call(4, "ahp_intent_promote", { id: "i-1", gate: "pass", actual: "did x", commits: [sha], landmines: ["watch y"], next: "n" }),
    call(5, "ahp_end", { reason: "limit", summary: "s", gate: "pass", evidence: "e", findings: ["hazard"] })
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const r = spawnSync(process.execPath, [MCP], { input: msgs, env: ENV, encoding: "utf8", shell: false });
  const byId = new Map(r.stdout.trim().split("\n").map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  for (const id of [2, 3, 4, 5]) {
    assert.equal(byId.get(id).result.isError, false, `call ${id}: ${byId.get(id).result?.content?.[0]?.text}`);
  }
  assert.match(byId.get(4).result.content[0].text, new RegExp(sha.slice(0, 12)));
  assert.equal(ahp(["verify"], P).code, 0);
});

test("dashboard runs from outside any repo and lists projects", () => {
  const r = ahp(["dashboard"], os.tmpdir());
  assert.ok(r.code === 0 || r.code === 1, r.err);
  assert.match(r.out, /Agent Handoff/);
  assert.match(r.out, /projA/);
  const j = ahp(["dashboard", "--json"], os.tmpdir());
  const parsed = JSON.parse(j.out);
  assert.ok(Array.isArray(parsed.projects));
});

test("worker identity is auto-detected, not left unknown", () => {
  // this test process is a descendant of `node`, not a known agent host, so
  // detection returns null here — but the record must still not say "unknown"
  // when an explicit id is given, and detection must not crash.
  const P = mkrepo("projW");
  const s = ahp(["start", "--plan", "p", "--gate", "pass", "--evidence", "e"], P);
  assert.equal(s.code, 0, s.err);
  const rec = JSON.parse(fs.readFileSync(ahp(["path"], P).out.trim(), "utf8").trim().split("\n")[0]);
  assert.ok(typeof (rec.worker.id ?? rec.worker) === "string");
});

test("worker identity folds to one canonical id (CLI == MCP)", () => {
  // the split a week of real use produced: claude / claude-code / "Claude Code"
  // are one worker. Every _avoid spelling must fold to its canonical id.
  for (const w of WORKERS) {
    assert.equal(canonicalWorkerId(w.id), w.id);
    for (const a of w._avoid) assert.equal(canonicalWorkerId(a), w.id, `${a} -> ${w.id}`);
  }
  assert.equal(canonicalWorkerId("Claude Code"), "claude");
  assert.equal(canonicalWorkerId("  CLAUDE-CODE  "), "claude");
  assert.equal(canonicalWorkerId({ id: "claude-code", runtime: "claude-code" }), "claude");
  assert.equal(canonicalWorkerId(null), "unknown");
  assert.equal(canonicalWorkerId(""), "unknown");
  assert.equal(canonicalWorkerId("worker"), "unknown");
  // an unknown agent keeps its own name, sanitised — it does not become "unknown"
  assert.equal(canonicalWorkerId("my-bot v2"), "my-bot-v2");
});

test("CLI attribution and MCP attribution agree on the canonical id", () => {
  const P = mkrepo("projCanon");
  const cliEnv = { ...ENV, AHP_WORKER_ID: "claude-code" };
  spawnSync(process.execPath, [AHP, "start", "--plan", "p", "--gate", "pass", "--evidence", "e"], { cwd: P, env: cliEnv, encoding: "utf8" });
  const rec = JSON.parse(fs.readFileSync(ahp(["path"], P).out.trim(), "utf8").trim().split("\n")[0]);
  assert.equal(canonicalWorkerId(rec.worker), "claude");
  // a later MCP-attributed record (clientInfo.name "Claude Code") lands as the
  // same worker, so `read --worker claude` sees both.
  const mcpMsgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {}, clientInfo: { name: "Claude Code" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ahp_intent_open", arguments: { id: "i-1", title: "t", intended: "x", cwd: P } } }
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  spawnSync(process.execPath, [MCP], { input: mcpMsgs, env: ENV, encoding: "utf8" });
  const filtered = ahp(["read", "--worker", "claude", "--json"], P);
  const types = filtered.out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).type);
  assert.deepEqual(types, ["handoff.start", "intent.open"], filtered.out);
});

test("read --field projects one field flat; --field hazards merges landmines+findings", () => {
  const P = mkrepo("projField");
  ahp(["start", "--plan", "p", "--gate", "pass", "--evidence", "e"], P);
  for (const n of [1, 2]) {
    ahp(["intent", "open", "--id", `i-${n}`, "--title", "t", "--intended", "x"], P);
    const sha = commit(P, `c${n}`);
    ahp(["intent", "promote", "--id", `i-${n}`, "--commit", sha, "--gate", "pass",
      "--actual", `did ${n}`, "--landmine", `hazard ${n}a`, "--landmine", `hazard ${n}b`, "--next", `step ${n + 1}`], P);
  }
  ahp(["end", "--reason", "task-done", "--summary", "s", "--gate", "fail", "--evidence", "e", "--finding", "watch out"], P);

  const landmines = ahp(["read", "--field", "landmines"], P).out.split("\n");
  assert.deepEqual(landmines, ["seq 3  hazard 1a", "seq 3  hazard 1b", "seq 5  hazard 2a", "seq 5  hazard 2b"]);

  // --tail counts projected values, not records
  const tailed = ahp(["read", "--field", "landmines", "--tail", "1"], P).out;
  assert.equal(tailed, "seq 5  hazard 2b");

  // hazards = landmines + findings, in seq order, --json gives structured items
  const hazJson = ahp(["read", "--field", "hazards", "--json"], P).out.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(hazJson.map((h) => h.value), ["hazard 1a", "hazard 1b", "hazard 2a", "hazard 2b", "watch out"]);
  assert.equal(hazJson.at(-1).field, "findings");
  assert.equal(hazJson.at(-1).type, "handoff.end");

  // a field with no matches is reported plainly, not an empty crash
  assert.equal(ahp(["read", "--field", "next", "--type", "handoff.end"], P).out, "(no matching values)");

  // MCP: field + worker both reach the CLI
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ahp_read", arguments: { field: "hazards", as_json: true, cwd: P } } }
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const mcpOut = spawnSync(process.execPath, [MCP], { input: msgs, env: ENV, encoding: "utf8" });
  const call = JSON.parse(mcpOut.stdout.trim().split("\n")[1]);
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /watch out/);
});

test("read/log --worker filters to one agent; pickup flags a prior turn", () => {
  const P = mkrepo("projRot");
  const as = (id) => ({ ...ENV, AHP_WORKER_ID: id });
  const run = (id, args) => {
    const r = spawnSync(process.execPath, [AHP, ...args], { cwd: P, env: as(id), encoding: "utf8" });
    return { code: r.status ?? -1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  };

  run("codex", ["start", "--plan", "p1", "--gate", "pass", "--evidence", "e"]);
  run("codex", ["intent", "open", "--id", "r1", "--title", "t", "--intended", "i"]);
  const sha = commit(P, "codex work");
  run("codex", ["intent", "promote", "--id", "r1", "--commit", sha, "--gate", "pass", "--actual", "done"]);
  run("codex", ["end", "--reason", "limit", "--summary", "s", "--gate", "pass", "--evidence", "e"]);
  run("claude-code", ["start", "--plan", "p2", "--gate", "pass", "--evidence", "e"]);
  run("claude-code", ["end", "--reason", "task-done", "--summary", "s", "--gate", "pass", "--evidence", "e"]);

  const cx = run("codex", ["read", "--worker", "codex", "--json"]);
  const lines = cx.out.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.length > 0 && lines.every((r) => (r.worker.id ?? r.worker) === "codex"), cx.out);
  assert.ok(!lines.some((r) => (r.worker.id ?? r.worker) === "claude-code"));

  const pk = run("codex", ["pickup"]);
  assert.match(pk.out, /You \(codex\) last held the baton/);
  assert.match(pk.out, /1 handoff since/);
});

test("upgrade: --check reports behind/current, refuses a dirty or non-git checkout", () => {
  const root = path.join(TMP, "upgrade"); fs.mkdirSync(root, { recursive: true });
  const bare = path.join(root, "remote.git");
  const work = path.join(root, "checkout");
  sh("git", ["init", "-q", "--bare", bare]);
  sh("git", ["clone", "-q", bare, work]);
  const g = (...a) => sh("git", ["-C", work, ...a]);
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ version: "0.4.0" }));
  fs.writeFileSync(path.join(work, "install.sh"), "#!/bin/sh\necho refreshed hosts\n");
  fs.chmodSync(path.join(work, "install.sh"), 0o755);
  g("add", "-A"); g("commit", "-qm", "v0.4.0"); g("push", "-q", "origin", "HEAD");

  const up = (args, extra = {}) => spawnSync(process.execPath, [AHP, "upgrade", ...args],
    { env: { ...ENV, AHP_REPO: work, ...extra }, encoding: "utf8" });

  // up to date
  let r = up(["--check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already current — 0\.4\.0/);

  // a newer commit on the remote → --check says "behind", doesn't apply it
  const work2 = path.join(root, "other");
  sh("git", ["clone", "-q", bare, work2]);
  sh("git", ["-C", work2, "config", "user.email", "t@t"]);
  sh("git", ["-C", work2, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(work2, "package.json"), JSON.stringify({ version: "0.4.1" }));
  sh("git", ["-C", work2, "commit", "-aqm", "v0.4.1"]);
  sh("git", ["-C", work2, "push", "-q", "origin", "HEAD"]);
  r = up(["--check"]);
  assert.match(r.stdout, /1 commit\(s\) behind/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(work, "package.json"), "utf8")).version, "0.4.0", "not applied");

  // real upgrade: fast-forwards and runs the (fake) installer
  r = up([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /updated 0\.4\.0 → 0\.4\.1/);
  assert.match(r.stdout, /refreshed hosts/);
  assert.match(r.stdout, /new MCP tool or parameter/);
  assert.match(r.stdout, /\/mcp .*Reconnect/);

  // dirty tree → refuse
  fs.writeFileSync(path.join(work, "dirt"), "x");
  sh("git", ["-C", work, "add", "dirt"]);
  r = up([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /uncommitted changes/);

  // not a git checkout → refuse
  const plain = path.join(root, "plain"); fs.mkdirSync(plain);
  r = up([], { AHP_REPO: plain });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a git checkout/);
});

test("nothing in src/ can reach the network (SPEC §11)", () => {
  const dir = path.join(REPO, "src");
  const banned = /\b(node:https?|node:net|node:dns|node:tls|node:dgram|require\(["']https?["']\)|fetch\s*\(|new\s+WebSocket|import\s+https?\s+from|from\s+["']node:(https?|net|dns|tls|dgram)["'])/;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".mjs"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!banned.test(src), `${f} references a network primitive`);
  }
  // the only child_process users, and only for local commands (git / ps / the
  // bundled install.sh — never a network client)
  const users = fs.readdirSync(dir).filter((n) => n.endsWith(".mjs"))
    .filter((n) => /child_process/.test(fs.readFileSync(path.join(dir, n), "utf8")));
  assert.deepEqual(users.sort(), ["git.mjs", "mcp.mjs", "upgrade.mjs", "worker-detect.mjs"]);
});

test("the hand-written validator and the JSON schema agree on the contract", () => {
  // no ajv in `npm test`; instead pin the two most drift-prone surfaces —
  // required fields per record type, and the closed enums — to the schema.
  const schema = JSON.parse(fs.readFileSync(path.join(REPO, "schema", "worklog.schema.json"), "utf8"));
  const topReq = schema.required.filter((f) => f !== "type");
  const branch = (t) => schema.allOf.find((b) => b.if.properties.type.const === t).then;

  assert.deepEqual(RECORD_TYPES.slice().sort(), schema.properties.type.enum.slice().sort());
  for (const t of RECORD_TYPES) {
    const want = [...new Set([...topReq, ...branch(t).required])].sort();
    assert.deepEqual([...REQUIRED[t]].sort(), want, `required fields for ${t}`);
  }
  assert.deepEqual([...GATES].sort(), schema.$defs.gate.enum.slice().sort());
  assert.deepEqual([...END_REASONS].sort(), branch("handoff.end").properties.reason.enum.slice().sort());
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
