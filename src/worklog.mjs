// Worklog read / append / analyze, with a per-project write lock and fsync.

import fs from "node:fs";
import path from "node:path";
import { parseJsonl, validateRecords } from "./validate.mjs";

const LOCK_STALE_MS = 60_000;

export function readText(worklogFile) {
  try { return fs.readFileSync(worklogFile, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return ""; throw e; }
}

export function readEntries(worklogFile) {
  return parseJsonl(readText(worklogFile)); // throws on a corrupt line
}

export function lastSeq(worklogFile) {
  const entries = readEntries(worklogFile);
  return entries.length === 0 ? 0 : entries[entries.length - 1].record.seq;
}

// Everything a pickup / status view needs, derived from the record stream.
export function analyze(entries) {
  const records = entries.map((e) => e.record);
  const { errors, warnings, stats } = validateRecords(entries);

  let lastStart = null;
  let batonHeld = false;
  let batonWorker = null;
  const openIntents = [];
  const promotedCommits = new Set();
  const promotes = [];

  for (const r of records) {
    if (r.type === "handoff.start") { lastStart = r; batonHeld = true; batonWorker = r.worker; }
    else if (r.type === "handoff.end") { batonHeld = false; }
    else if (r.type === "intent.promote") {
      promotes.push(r);
      for (const c of r.commits ?? []) promotedCommits.add(c);
    }
  }
  const promotedIds = new Set(promotes.map((p) => p.intentId));
  for (const r of records) {
    if (r.type === "intent.open" && !promotedIds.has(r.intentId)) openIntents.push(r);
  }

  return {
    records,
    count: records.length,
    lastSeq: records.length ? records[records.length - 1].seq : 0,
    lastStart,
    batonHeld,
    batonWorker,
    openIntents,
    promotes,
    promotedCommits: [...promotedCommits],
    validation: { errors, warnings, stats }
  };
}

// --- write path -------------------------------------------------------------

function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // stale-lock reclaim: dead pid, or older than LOCK_STALE_MS
      let stale = false;
      try {
        const [pidLine, tsLine] = fs.readFileSync(lockFile, "utf8").split("\n");
        const pid = Number.parseInt(pidLine, 10);
        const age = Date.now() - Date.parse(tsLine || "");
        const alive = pidAlive(pid);
        if (!alive || (Number.isFinite(age) && age > LOCK_STALE_MS)) stale = true;
      } catch { stale = true; }
      if (stale) { try { fs.rmSync(lockFile, { force: true }); } catch { /* race */ } continue; }
      sleepMs(20);
    }
  }
  throw new Error(`could not acquire worklog lock: ${lockFile}`);
}

function releaseLock(lockFile) {
  try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

// Append one record. Assigns `seq` and `at` if absent. Runs under the lock,
// re-reads the tail so `seq` is correct, refuses to append after a corrupt line.
export function appendRecord(worklogFile, lockFile, record, { now = () => new Date().toISOString() } = {}) {
  fs.mkdirSync(path.dirname(worklogFile), { recursive: true });
  acquireLock(lockFile);
  try {
    let entries;
    try { entries = readEntries(worklogFile); }
    catch (e) { throw new Error(`worklog is corrupt (${e.message}); fix it before appending`); }
    const prevSeq = entries.length ? entries[entries.length - 1].record.seq : 0;
    const full = { ...record };
    if (full.seq === undefined) full.seq = prevSeq + 1;
    if (full.at === undefined) full.at = now();
    if (!Number.isSafeInteger(full.seq) || full.seq <= prevSeq) {
      throw new Error(`seq ${full.seq} is not greater than the last seq ${prevSeq}`);
    }
    const line = `${JSON.stringify(full)}\n`;
    const fd = fs.openSync(worklogFile, "a");
    try { fs.writeSync(fd, line); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return full;
  } finally {
    releaseLock(lockFile);
  }
}
