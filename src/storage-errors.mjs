// Turn opaque filesystem failures into concise, evidence-backed guidance for
// the agent that can inspect permissions, request sandbox access, and retry.

import fs from "node:fs";
import path from "node:path";

function accessLabel(target, mode) {
  try { fs.accessSync(target, mode); return "yes"; }
  catch { return "no"; }
}

function nearestExistingParent(target) {
  let current = path.dirname(target);
  while (current !== path.dirname(current) && !fs.existsSync(current)) current = path.dirname(current);
  return current;
}

export function explainStoreFsError(error, { operation, target, effect = "No AHP worklog record was written." }) {
  if (!error || !error.code) return error;
  const parent = nearestExistingParent(target);
  let context = `parent ${parent}`;
  let likely = "file ownership/mode/ACL, a read-only mount, or an execution sandbox policy";
  try {
    const parentStat = fs.statSync(parent);
    const uid = typeof process.getuid === "function" ? process.getuid() : "?";
    const gid = typeof process.getgid === "function" ? process.getgid() : "?";
    const parentReadable = accessLabel(parent, fs.constants.R_OK);
    const parentWritable = accessLabel(parent, fs.constants.W_OK);
    context += ` · process uid:gid ${uid}:${gid} · owner ${parentStat.uid}:${parentStat.gid} · mode 0${(parentStat.mode & 0o777).toString(8)} · R/W ${parentReadable}/${parentWritable}`;
    let targetWritable = null;
    if (fs.existsSync(target)) {
      const targetStat = fs.statSync(target);
      targetWritable = accessLabel(target, fs.constants.W_OK);
      context += ` · target owner ${targetStat.uid}:${targetStat.gid} mode 0${(targetStat.mode & 0o777).toString(8)} W ${targetWritable}`;
    }
    if (error.code === "ENOSPC") likely = "the filesystem is out of free space";
    else if (error.code === "EDQUOT") likely = "the process or user has exhausted its storage quota";
    else if (error.code === "EROFS") likely = "a read-only filesystem or mount";
    else if (targetWritable === "no") likely = "the target file's ownership, mode, or ACL (the file write probe failed)";
    else if (["EACCES", "EPERM"].includes(error.code) && parentWritable === "yes") likely = "an execution sandbox/security policy or a filesystem-specific restriction (the parent write probe passed)";
    else if (["EACCES", "EPERM"].includes(error.code)) likely = "parent-directory ownership/mode/ACL, a read-only mount, or a sandbox denial (the parent write probe failed)";
    else likely = `a filesystem/runtime failure identified by ${error.code}; inspect the OS error and target`;
  } catch { /* retain the conservative diagnosis */ }

  const deniedAt = error.path && error.path !== target ? ` at ${error.path}` : "";
  const wrapped = new Error([
    `[AHP_STORE_IO_FAILED] The filesystem/runtime did not complete AHP's attempt to ${operation}; this was not an AHP policy decision.`,
    `target: ${target}`,
    `os: ${error.code}${error.syscall ? ` during ${error.syscall}` : ""}${deniedAt} · ${context}`,
    `likely: ${likely}`,
    `state: ${effect}`,
    "agent next: inspect `id` and `ls -ld` for the target parent (plus ACLs, if supported); check whether the store is a read-only mount. If ownership/mode look writable but access is still denied, request sandbox permission for the AHP store. Then retry the same AHP command and require exit 0.",
  ].join("\n"));
  wrapped.code = "AHP_STORE_IO_FAILED";
  wrapped.cause = error;
  return wrapped;
}
