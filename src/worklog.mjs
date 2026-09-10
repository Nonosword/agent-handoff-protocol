// Worklog read / append / analyze, with a per-Lane write lock and fsync.

import fs from "node:fs";
import path from "node:path";
import { parseJsonl, validateRecords } from "./validate.mjs";
import { project } from "./lifecycle.mjs";
import { explainStoreFsError } from "./storage-errors.mjs";

export function readText(worklogFile) {
  try { return fs.readFileSync(worklogFile, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return "";
    throw explainStoreFsError(error, {
      operation: "read the selected Lane worklog",
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

export function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let fd;
    let token;
    try {
      fd = fs.openSync(lockFile, "wx", 0o600);
      token = `${process.pid}\n${new Date().toISOString()}\n${process.pid}-${Math.random().toString(36).slice(2)}\n`;
      writeAllSync(fd, token);
      fs.fsyncSync(fd);
      return token;
    } catch (e) {
      if (e.code !== "EEXIST") {
        // A failed exclusive create says nothing about an existing owner's
        // validity. In particular, EACCES/EROFS must never unlink its lock.
        if (token) releaseLock(lockFile, token);
        throw e;
      }
      // Reclaim only a lock whose recorded PID is definitely dead. A live PID
      // wins over its age: a paused process or slow mount must not admit a
      // second writer into the critical section.
      let stale = false;
      try {
        const [pidLine] = fs.readFileSync(lockFile, "utf8").split("\n");
        const pid = /^\d+$/.test(pidLine) ? Number(pidLine) : NaN;
        // An empty file is observable between exclusive creation and the first
        // write. It is an initializing owner, not proof of a dead one. Reclaim
        // only a syntactically valid PID that we can prove is gone.
        if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) stale = true;
      } catch { /* unreadable/invalid locks are not safe to reclaim */ }
      if (stale) { try { fs.rmSync(lockFile, { force: true }); } catch { /* race */ } continue; }
      sleepMs(20);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  const error = new Error(`could not acquire file lock: ${lockFile}`);
  error.code = "EBUSY";
  error.path = lockFile;
  throw error;
}

export function releaseLock(lockFile, token = null) {
  try {
    // Do not delete a lock that was replaced after an error/recovery race.
    if (token !== null && fs.readFileSync(lockFile, "utf8") !== token) return;
    fs.rmSync(lockFile, { force: true });
  } catch { /* best effort */ }
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

export function writeAllSync(fd, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) {
      const error = new Error("short write while writing store data");
      error.code = "EIO";
      throw error;
    }
    offset += written;
  }
}

// A durable replacement for small registry/worklog files. Callers decide the
// locking policy; this function makes one replacement crash-safe locally.
export function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  let fd;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, "wx", 0o600);
    writeAllSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    // fsyncing the replacement alone does not make the directory entry durable
    // on filesystems that require the containing directory to be synced too.
    syncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function syncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // Some platforms do not permit opening/fsyncing a directory. The file
    // replacement itself remains atomic; this is the strongest portable best
    // effort available without turning a successful replacement into an error.
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

// Append one record. Assigns `seq` and `at` if absent. Runs under the lock,
// re-reads the tail so `seq` is correct, refuses to append after a corrupt line.
// `precondition(records, full)` and `derive(full, entries)` run under the same
// lock after re-reading the worklog. This makes lifecycle checks atomic with the
// append rather than trusting an earlier snapshot.
export function appendRecord(worklogFile, lockFile, record, { now = () => new Date().toISOString(), precondition, derive } = {}) {
  let lockToken;
  try {
    fs.mkdirSync(path.dirname(worklogFile), { recursive: true });
    lockToken = acquireLock(lockFile);
  } catch (error) {
    throw explainStoreFsError(error, {
      operation: "prepare the worklog write",
      target: worklogFile,
      effect: "No worklog record was written."
    });
  }
  return appendUnderLock(worklogFile, record, { now, precondition, derive, lockFile, lockToken });
}

function appendUnderLock(worklogFile, record, { now, precondition, derive, lockFile, lockToken }) {
  try {
    let text;
    let entries;
    try {
      text = readText(worklogFile);
      entries = parseJsonl(text);
    }
    catch (e) { throw new Error(`worklog is corrupt (${e.message}); fix it before appending`); }
    const prevSeq = entries.length ? entries[entries.length - 1].record.seq : 0;
    const full = { ...record };
    if (full.seq === undefined) full.seq = prevSeq + 1;
    if (full.at === undefined) full.at = now();
    if (!Number.isSafeInteger(full.seq) || full.seq <= prevSeq) {
      throw new Error(`seq ${full.seq} is not greater than the last seq ${prevSeq}`);
    }
    const records = entries.map((entry) => entry.record);
    if (precondition) precondition(records, full);
    if (derive) Object.assign(full, derive(full, entries));
    const validation = validateRecords([...entries, { record: full, no: entries.length + 1 }]);
    if (validation.errors.length) {
      throw new Error(`refusing to append an invalid worklog record:\n${validation.errors.join("\n")}`);
    }
    const line = `${JSON.stringify(full)}\n`;
    let fd;
    let writeStarted = false;
    try {
      fd = fs.openSync(worklogFile, "a");
      // Once a descriptor is open for append, a failed full-write may already
      // have placed a prefix on disk; never tell a caller it is safe to retry.
      writeStarted = true;
      // JSONL permits a final line without a terminal newline, but appending
      // after it without a delimiter would concatenate two JSON values. Keep
      // the historic record byte-for-byte and add only the missing separator.
      if (text && !text.endsWith("\n")) writeAllSync(fd, "\n");
      writeAllSync(fd, line);
      fs.fsyncSync(fd);
    } catch (error) {
      throw explainStoreFsError(error, {
        operation: "append and sync the worklog record",
        target: worklogFile,
        effect: writeStarted
          ? "The append may have reached the file. Run `ahp status --lane <id>` or `ahp verify --lane <id>` for the same selected Lane before retrying to avoid a duplicate record."
          : "No record bytes were written."
      });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return full;
  } finally {
    releaseLock(lockFile, lockToken);
  }
}
