// Last-resort worker identity: walk up the process tree and, if an ancestor is
// a known agent host, use its name. Zero-config attribution for `ahp` run
// directly by an agent's shell (Codex, Claude Code, Cursor, Aider, …).
// Explicit --worker-id and the AHP_* env vars always win over this.

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const KNOWN = [
  [/\bcodex\b/, "codex"],
  [/\bclaude\b/, "claude-code"],
  [/\bcursor\b/, "cursor"],
  [/\baider\b/, "aider"],
  [/\bcline\b/, "cline"],
  [/\bopencode\b/, "opencode"],
  [/\bgoose\b/, "goose"]
];

function procInfo(pid) {
  // Linux fast path: /proc/<pid>/stat — "pid (comm) state ppid ..."
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(open + 1, close);
    const ppid = Number(stat.slice(close + 2).trim().split(/\s+/)[1]);
    let cmd = comm;
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim() || comm; } catch { /* keep comm */ }
    return { cmd, ppid };
  } catch { /* fall through */ }
  // Portable fallback: ps
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const ppid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    return { cmd, ppid };
  } catch { return null; }
}

export function detectRuntime() {
  let pid = process.ppid;
  for (let depth = 0; depth < 14 && pid > 1; depth += 1) {
    const info = procInfo(pid);
    if (!info) break;
    const hay = info.cmd.toLowerCase();
    for (const [re, label] of KNOWN) if (re.test(hay)) return label;
    if (!info.ppid || info.ppid === pid) break;
    pid = info.ppid;
  }
  return null;
}
