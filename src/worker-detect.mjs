// Worker identity: one canonical vocabulary, used the same way by the CLI and
// the MCP server so a session is never split across `claude` / `claude-code` /
// `unknown` for what is one agent.
//
//   - `canonicalWorkerId(raw)` folds any spelling to a canonical id. This is the
//     value used for attribution and for "is this my own earlier turn"; the
//     `worker` object may still carry a finer `runtime` (e.g. `claude-code`).
//   - `detectRuntime()` is the last-resort guess: walk the process tree and, if
//     an ancestor is a known agent host, return its canonical id. Explicit
//     --worker-id and the AHP_* env vars always win over this.
//
// Privacy: detectRuntime reads ancestor process command lines (/proc or `ps`).
// It only regex-tests them against the WORKERS names below and returns a
// canonical id — the command line is never stored, logged, or transmitted.
// Nothing in this module makes a network request (SPEC §11).

import fs from "node:fs";
import { execFileSync } from "node:child_process";

// The canonical ids AHP attributes work to. One row per agent, with the
// spellings seen in the wild that must fold to it. `_avoid` is the near-miss
// list SPEC §2 forbids — kept here so the code and the spec cannot drift.
export const WORKERS = [
  { id: "claude", match: [/\bclaude\b/], _avoid: ["claude-code", "claude code", "claudecode", "claude-desktop", "cc"] },
  { id: "codex", match: [/\bcodex\b/], _avoid: ["codex-cli", "openai-codex", "oai-codex"] },
  { id: "cursor", match: [/\bcursor\b/], _avoid: ["cursor-agent", "cursor ide"] },
  { id: "gemini", match: [/\bgemini\b/, /\bgemini-cli\b/], _avoid: ["gemini-cli", "google-gemini"] },
  { id: "aider", match: [/\baider\b/], _avoid: [] },
  { id: "cline", match: [/\bcline\b/], _avoid: ["claude-dev"] },
  { id: "opencode", match: [/\bopencode\b/], _avoid: ["open-code", "open code"] },
  { id: "goose", match: [/\bgoose\b/], _avoid: [] },
  { id: "windsurf", match: [/\bwindsurf\b/], _avoid: ["codeium-windsurf", "windsurf-cascade", "cascade"] },
  { id: "qoder", match: [/\bqoder\b/], _avoid: [] },
  { id: "vscode", match: [/\bvscode\b/, /\bvs-code\b/, /\bcopilot\b/], _avoid: ["vs-code", "vs code", "github-copilot", "code-copilot"] }
];

const ALIAS = new Map();
for (const w of WORKERS) {
  ALIAS.set(w.id, w.id);
  for (const a of w._avoid) ALIAS.set(a, w.id);
}

const norm = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, "-");

// A single spelling -> a known canonical id, or null.
function knownId(s) {
  if (s === "" || s === "unknown" || s === "worker") return null;
  if (ALIAS.has(s)) return ALIAS.get(s);
  for (const w of WORKERS) if (w.match.some((re) => re.test(s))) return w.id;
  return null;
}

// Fold a worker (string, or `{id, model, runtime}`) to its canonical id. For the
// object form, the first of id / model / runtime that names a known agent wins;
// otherwise the id keeps its own sanitised name. Unknown agents are not
// collapsed to "unknown" — only a genuinely absent identity is.
export function canonicalWorkerId(raw) {
  if (raw == null) return "unknown";
  if (typeof raw === "object") {
    for (const cand of [raw.id, raw.model, raw.runtime]) {
      const k = knownId(norm(cand));
      if (k) return k;
    }
    return sanitise(norm(raw.id));
  }
  const s = norm(raw);
  return knownId(s) ?? sanitise(s);
}

function sanitise(s) {
  if (s === "" || s === "unknown" || s === "worker") return "unknown";
  return s.replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

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
    for (const w of WORKERS) if (w.match.some((re) => re.test(hay))) return w.id;
    if (!info.ppid || info.ppid === pid) break;
    pid = info.ppid;
  }
  return null;
}
