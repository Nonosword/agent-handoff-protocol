// ahp MCP server — Model Context Protocol over stdio, zero dependencies.
//
// Newline-delimited JSON-RPC 2.0. Implements: initialize, tools/list,
// tools/call, ping, and swallows notifications. Each tool shells out to the
// `ahp` CLI so behaviour is identical by construction.
//
// Run:  node src/mcp.mjs        (host sets cwd; tools also accept an explicit cwd)

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AHP_BIN = path.join(HERE, "..", "bin", "ahp");
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
const PROTOCOL_VERSION = "2025-06-18";

const COMMON = {
  cwd: { type: "string", description: "directory to resolve the project from (default: the server's working directory)" },
  project: { type: "string", description: "explicit project id or name (overrides cwd detection)" }
};

const TOOLS = [
  {
    name: "ahp_status",
    description: "Project, baton holder, open intents, and working-tree / gate state for the current project.",
    inputSchema: { type: "object", properties: { ...COMMON } }
  },
  {
    name: "ahp_pickup",
    description: "Guided AHP pickup: the last handoff, the commits since its base, reconciliation against intent.promote records, and open intents. READ-ONLY. Run this before taking the baton.",
    inputSchema: { type: "object", properties: { ...COMMON } }
  },
  {
    name: "ahp_start",
    description: "Append handoff.start — take the baton. Records the verified base commit, tree state and gate result you observed.",
    inputSchema: {
      type: "object",
      required: ["plan", "gate"],
      properties: {
        plan: { type: "string", description: "what you intend to attempt this session" },
        gate: { type: "string", enum: ["pass", "fail", "not-run"], description: "result of running the project's own gate right now" },
        evidence: { type: "string", description: "short proof, e.g. '312 tests pass'" },
        continues: { type: "number", description: "seq of the handoff.start you continue from (default: the last one)" },
        worker_id: { type: "string" }, model: { type: "string" }, runtime: { type: "string" },
        ...COMMON
      }
    }
  },
  {
    name: "ahp_intent_open",
    description: "Append intent.open — declare a planned unit of work before you start it.",
    inputSchema: {
      type: "object",
      required: ["id", "title", "intended"],
      properties: {
        id: { type: "string", description: "short unique id, e.g. i-0828-a" },
        title: { type: "string" },
        intended: { type: "string", description: "what you plan to do and why" },
        refs: { type: "array", items: { type: "string" } },
        scope: { type: "array", items: { type: "string" } },
        ...COMMON
      }
    }
  },
  {
    name: "ahp_intent_promote",
    description: "Append intent.promote — record that an intent's commit landed, with the actual result, any landmines, and the next step.",
    inputSchema: {
      type: "object",
      required: ["id", "gate", "actual"],
      properties: {
        id: { type: "string" },
        commits: { type: "array", items: { type: "string" }, description: "commit(s) that realized this intent; required unless gate is 'fail'" },
        gate: { type: "string", enum: ["pass", "fail", "not-run"] },
        actual: { type: "string", description: "what was actually done, including deviations from the intent" },
        landmines: { type: "array", items: { type: "string" }, description: "hazards / shortcuts / deferred work; required if gate is 'fail'" },
        next: { type: "string" },
        ...COMMON
      }
    }
  },
  {
    name: "ahp_end",
    description: "Append handoff.end (best-effort) — release the baton. Records the end commit/gate, a summary, carried-over open intents and findings.",
    inputSchema: {
      type: "object",
      required: ["reason", "summary", "gate"],
      properties: {
        reason: { type: "string", enum: ["limit", "task-done", "blocked", "handoff-requested"] },
        summary: { type: "string" },
        gate: { type: "string", enum: ["pass", "fail", "not-run"] },
        evidence: { type: "string" },
        findings: { type: "array", items: { type: "string" }, description: "hazards for the next worker; required if gate is not 'pass'" },
        ...COMMON
      }
    }
  },
  {
    name: "ahp_read",
    description: "Read worklog records for the current project (human-readable, or raw with as_json).",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number" }, tail: { type: "number" }, type: { type: "string" },
        as_json: { type: "boolean" },
        ...COMMON
      }
    }
  },
  {
    name: "ahp_verify",
    description: "Structural + lifecycle check of the current project's worklog.",
    inputSchema: { type: "object", properties: { strict: { type: "boolean" }, ...COMMON } }
  }
];

function toArgv(name, a = {}) {
  const g = [];
  if (a.project) g.push("--project", String(a.project));
  if (a.cwd) g.push("--cwd", String(a.cwd));
  const list = (flag, arr) => (arr ?? []).forEach((v) => g.push(flag, String(v)));
  switch (name) {
    case "ahp_status": return ["status", ...g];
    case "ahp_pickup": return ["pickup", ...g];
    case "ahp_verify": return ["verify", ...(a.strict ? ["--strict"] : []), ...g];
    case "ahp_read": {
      const r = ["read", ...g];
      if (a.since != null) r.push("--since", String(a.since));
      if (a.tail != null) r.push("--tail", String(a.tail));
      if (a.type) r.push("--type", String(a.type));
      if (a.as_json) r.push("--json");
      return r;
    }
    case "ahp_start": {
      const r = ["start", "--plan", String(a.plan), ...g];
      if (a.gate) r.push("--gate", String(a.gate));
      if (a.evidence) r.push("--evidence", String(a.evidence));
      if (a.continues != null) r.push("--continues", String(a.continues));
      if (a.worker_id) r.push("--worker-id", String(a.worker_id));
      if (a.model) r.push("--model", String(a.model));
      if (a.runtime) r.push("--runtime", String(a.runtime));
      return r;
    }
    case "ahp_intent_open": {
      const r = ["intent", "open", "--id", String(a.id), "--title", String(a.title), "--intended", String(a.intended), ...g];
      list("--ref", a.refs); list("--scope", a.scope);
      return r;
    }
    case "ahp_intent_promote": {
      const r = ["intent", "promote", "--id", String(a.id), "--gate", String(a.gate), "--actual", String(a.actual), ...g];
      list("--commit", a.commits); list("--landmine", a.landmines);
      if (a.next) r.push("--next", String(a.next));
      return r;
    }
    case "ahp_end": {
      const r = ["end", "--reason", String(a.reason), "--summary", String(a.summary), ...g];
      if (a.gate) r.push("--gate", String(a.gate));
      if (a.evidence) r.push("--evidence", String(a.evidence));
      list("--finding", a.findings);
      return r;
    }
    default: throw new Error(`unknown tool: ${name}`);
  }
}

function callTool(name, args) {
  const argv = toArgv(name, args);
  const res = spawnSync(process.execPath, [AHP_BIN, ...argv], { encoding: "utf8", shell: false });
  const out = `${res.stdout ?? ""}${res.stderr ? `\n${res.stderr}` : ""}`.trim();
  return { text: out || "(no output)", isError: (res.status ?? 1) !== 0 };
}

// --- JSON-RPC plumbing ---------------------------------------------------

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function handle(msg) {
  if (msg.method && msg.id === undefined) return; // notification
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "agent-handoff-protocol", version: PKG.version }
      });
    }
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") return reply(id, { tools: TOOLS });
    if (method === "tools/call") {
      const { name, arguments: args } = params ?? {};
      const r = callTool(name, args ?? {});
      return reply(id, { content: [{ type: "text", text: r.text }], isError: r.isError });
    }
    return fail(id, -32601, `method not found: ${method}`);
  } catch (e) {
    return fail(id, -32603, e.message);
  }
}

export function serve() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); }
    catch { return; }
    handle(msg);
  });
  rl.on("close", () => process.exit(0));
}

if (import.meta.url === `file://${process.argv[1]}`) serve();
