// Worklog read / append / analyze, with a per-project write lock and fsync.

import fs from "node:fs";
import path from "node:path";
import { parseJsonl, validateRecords } from "./validate.mjs";
import { project } from "./lifecycle.mjs";
import { explainStoreFsError } from "./storage-errors.mjs";

const LOCK_STALE_MS = 60_000;

export function readText(worklogFile) {
  try { return fs.readFileSync(worklogFile, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return "";
    throw explainStoreFsError(error, {
      operation: "read the project worklog",
      target: worklogFile,
      effect: "No state was changed; the worklog could not be read."
    });
  }
}

export function readEntries(worklogFile) {
  return parseJsonl(readText(worklogFile)); // throws on a corrupt line
}

export function lastSeq(worklogFile) {
  const entries = readEntries(worklogFile);
  return entries.length === 0 ? 0 : entries[entries.length - 1].record.seq;
}

// Everything a pickup / status view needs, derived from the record stream.
// The baton projection lives in lifecycle.mjs so the write path and the read
// path agree on it.
export function analyze(entries) {
  const records = entries.map((e) => e.record);
  const { errors, warnings, notes, stats } = validateRecords(entries);
  return {
    records,
    count: records.length,
    lastSeq: records.length ? records[records.length - 1].seq : 0,
    ...project(records),
    validation: { errors, warnings, notes, stats }
  };
}

// --- write path -------------------------------------------------------------

function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      fs.fsyncSync(fd);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") {
        try { fs.rmSync(lockFile, { force: true }); } catch { /* best effort */ }
        throw e;
      }
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
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
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
// `derive(full)` runs after `seq`/`at` are assigned and its result is merged in
// — for fields computed from the final seq (e.g. a handoff.start's sessionId).
export function appendRecord(worklogFile, lockFile, record, { now = () => new Date().toISOString(), derive } = {}) {
  try {
    fs.mkdirSync(path.dirname(worklogFile), { recursive: true });
    acquireLock(lockFile);
  } catch (error) {
    throw explainStoreFsError(error, {
      operation: "prepare the worklog write",
      target: worklogFile,
      effect: "No worklog record was written."
    });
  }
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
    if (derive) Object.assign(full, derive(full));
    const line = `${JSON.stringify(full)}\n`;
    let fd;
    let writeStarted = false;
    try {
      fd = fs.openSync(worklogFile, "a");
      writeStarted = fs.writeSync(fd, line) > 0;
      fs.fsyncSync(fd);
    } catch (error) {
      throw explainStoreFsError(error, {
        operation: "append and sync the worklog record",
        target: worklogFile,
        effect: writeStarted
          ? "The append may have reached the file. Run `ahp status` or `ahp verify` before retrying to avoid a duplicate record."
          : "No record bytes were written."
      });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return full;
  } finally {
    releaseLock(lockFile);
  }
}
