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
import { canonicalWorkerId } from "./worker-detect.mjs";
import * as git from "./git.mjs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AHP_BIN = path.join(HERE, "..", "bin", "ahp");
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
const PROTOCOL_VERSION = "2025-06-18";

const COMMON = {
  cwd: { type: "string", description: "absolute directory inside the target Git checkout. Required when a desktop MCP host does not inherit the chat's project directory; project may be supplied instead." },
  project: { type: "string", description: "registered project id or name (overrides cwd detection; use when an absolute cwd is unavailable)" },
  lane: { type: "string", description: "existing Lane id, title, or alias; omit only when the Project has no selection ambiguity" }
};

const schema = (properties, required = []) => ({
  type: "object",
  additionalProperties: false,
  ...(required.length ? { required } : {}),
  properties
});

const TOOLS = [
  {
    name: "ahp_status",
    description: "Selected Lane, baton holder, open intents, and current working-tree / gate state. Desktop hosts must pass the target checkout's absolute cwd, or project.",
    inputSchema: schema({ ...COMMON })
  },
  {
    name: "ahp_pickup",
    description: "Compact guided pickup for the selected Lane: last handoff, prioritised commit reconciliation and open intents. READ-ONLY. Run before taking the baton; set full only when omitted detail is needed.",
    inputSchema: schema({ full: { type: "boolean", description: "include every commit, intent and historical reachability check" }, ...COMMON })
  },
  {
    name: "ahp_start",
    description: "Append handoff.start — take the baton. Records the verified base commit, tree state and gate result you observed. Explicitly selecting a done Lane reopens it only if the start succeeds.",
    inputSchema: schema({
        plan: { type: "string", description: "what you intend to attempt this session" },
        gate: { type: "string", enum: ["pass", "fail", "not-run"], description: "result of running the project's own gate right now" },
        evidence: { type: "string", description: "short proof, e.g. '312 tests pass'" },
        continues: { type: "integer", minimum: 1, description: "seq of the latest handoff.start being continued; omit to derive it automatically" },
        worker_id: { type: "string", description: "explicit canonical worker id; normally supplied by the MCP host environment" },
        model: { type: "string", description: "optional model metadata for this worker" },
        runtime: { type: "string", description: "optional host/runtime metadata for this worker" },
        ...COMMON
      }, ["plan", "gate"])
  },
  {
    name: "ahp_intent_open",
    description: "Append intent.open — declare a planned unit of work before you start it.",
    inputSchema: schema({
        id: { type: "string", description: "short unique id, e.g. i-0828-a" },
        title: { type: "string", description: "concise human-readable name for this unit of work" },
        intended: { type: "string", description: "what you plan to do and why" },
        refs: { type: "array", items: { type: "string" }, description: "related issue, ticket, document, or commit references" },
        scope: { type: "array", items: { type: "string" }, description: "files, directories, or globs expected to change" },
        ...COMMON
      }, ["id", "title", "intended"])
  },
  {
    name: "ahp_intent_promote",
    description: "Append intent.promote — record that an intent's commit landed, with the actual result, any landmines, and the next step.",
    inputSchema: schema({
        id: { type: "string", description: "id of the previously opened intent" },
        commits: { type: "array", items: { type: "string" }, description: "commit(s) that realized this intent; required unless gate is 'fail'" },
        gate: { type: "string", enum: ["pass", "fail", "not-run"], description: "gate result after implementing this intent" },
        actual: { type: "string", description: "what was actually done, including deviations from the intent" },
        landmines: { type: "array", items: { type: "string" }, description: "hazards / shortcuts / deferred work; required if gate is 'fail'" },
        next: { type: "string", description: "concrete follow-up for the next worker, if any" },
        ...COMMON
      }, ["id", "gate", "actual"])
  },
  {
    name: "ahp_end",
    description: "Append handoff.end (best-effort) — release the session baton. This does not change Lane lifecycle status; after reason task-done, separately set the Lane to done once completion guards pass.",
    inputSchema: schema({
        reason: { type: "string", enum: ["limit", "task-done", "blocked", "handoff-requested"], description: "why this session is releasing the baton" },
        summary: { type: "string", description: "concise account of the session outcome and remaining work" },
        gate: { type: "string", enum: ["pass", "fail", "not-run"], description: "project gate result at the end boundary" },
        evidence: { type: "string", description: "short proof supporting the gate result" },
        findings: { type: "array", items: { type: "string" }, description: "hazards for the next worker; required if gate is not 'pass'" },
        ...COMMON
      }, ["reason", "summary", "gate"])
  },
  {
    name: "ahp_project_list",
    description: "List every registered Project so desktop agents can discover stable project ids, names, known checkout roots, and remotes without inheriting a Git cwd. READ-ONLY and runs from anywhere.",
    inputSchema: schema({
      as_json: { type: "boolean", description: "return a JSON array instead of tab-separated human-readable rows" }
    })
  },
  {
    name: "ahp_lane_list",
    description: "List active and done Lanes for safe task routing. Pass all:true only when archived history is relevant.",
    inputSchema: schema({
      all: { type: "boolean", description: "include intentionally hidden archived Lanes; omit for normal active + done discovery" },
      as_json: { type: "boolean", description: "return a JSON array rather than human-readable rows" },
      cwd: COMMON.cwd, project: COMMON.project
    })
  },
  {
    name: "ahp_lane_create",
    description: "Create a Lane when no existing Lane matches the task. The agent supplies its concise specification; a human may edit it later.",
    inputSchema: schema({
      id: { type: "string", description: "optional stable slug; derived from title when omitted" },
      title: { type: "string", description: "concise human-readable Lane name" },
      description: { type: "string", description: "specific purpose and boundary used by future agents for routing" },
      scope: { type: "array", items: { type: "string" }, description: "files, areas, or concepts normally owned by this Lane" },
      aliases: { type: "array", items: { type: "string" }, description: "additional unique names that should resolve to this Lane" },
      cwd: COMMON.cwd, project: COMMON.project
    }, ["title", "description"])
  },
  {
    name: "ahp_lane_edit",
    description: "Edit Lane metadata or lifecycle status. done/archived require a free baton, no open intents and strict verification. Invalid immutable history needs an operator-reviewed CLI disposition and cannot be bypassed through MCP.",
    inputSchema: schema({
      lane: { type: "string", description: "existing Lane id, title, or alias to edit" },
      title: { type: "string", description: "replacement human-readable title" },
      description: { type: "string", description: "replacement routing description" },
      status: { type: "string", enum: ["active", "done", "archived"], description: "active accepts writes; done is complete but discoverable; archived is complete and hidden by default" },
      scope: { type: "array", items: { type: "string" }, description: "complete replacement scope list" },
      aliases: { type: "array", items: { type: "string" }, description: "complete replacement alias list" },
      cwd: COMMON.cwd, project: COMMON.project
    }, ["lane"])
  },
  {
    name: "ahp_read",
    description: "Read worklog records for the selected Lane (human-readable, or raw with as_json). `field` projects one field flat across matching records instead of whole records — e.g. field:\"landmines\" or field:\"next\"; field:\"hazards\" pulls landmines + findings together (what the next worker must know). With field set, `tail` counts values, not records.",
    inputSchema: schema({
        since: { type: "integer", minimum: 0, description: "return records whose seq is greater than this non-negative integer" },
        tail: { type: "integer", minimum: 0, description: "return only the last N matching records or projected values; zero returns none" },
        type: { type: "string", description: "return only this exact record type" },
        worker: { type: "string", description: "return only records attributed to this canonical worker" },
        field: { type: "string", description: "project one field flat; hazards combines landmines and findings" },
        as_json: { type: "boolean", description: "emit newline-delimited JSON instead of human-readable output" },
        ...COMMON
      })
  },
  {
    name: "ahp_verify",
    description: "Structural + lifecycle check of the selected Lane's worklog. Strict by default (a quality warning fails); pass lenient:true for an old or knowingly-messy log.",
    inputSchema: schema({ lenient: { type: "boolean", description: "report quality warnings without failing; structural and lifecycle errors remain fatal" }, ...COMMON })
  }
];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalidParams = (message) => Object.assign(new Error(message), { rpcCode: -32602 });

function assertToolArguments(name, args) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw invalidParams(`unknown tool: ${name}`);
  if (!isObject(args)) throw invalidParams("tools/call arguments must be an object");
  const schema = tool.inputSchema;
  for (const required of schema.required ?? []) {
    const value = args[required];
    if (typeof value !== "string" || !value.trim()) {
      throw invalidParams(`tools/call requires a non-empty string argument "${required}"`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties?.[key];
    if (!rule) throw invalidParams(`unknown tools/call argument "${key}" for ${name}`);
    if (value === undefined) continue;
    if (rule.type === "string" && typeof value !== "string") throw invalidParams(`tools/call argument "${key}" must be a string`);
    if (rule.type === "number" && (!Number.isFinite(value))) throw invalidParams(`tools/call argument "${key}" must be a finite number`);
    if (rule.type === "integer" && !Number.isSafeInteger(value)) throw invalidParams(`tools/call argument "${key}" must be a safe integer`);
    if (rule.minimum !== undefined && value < rule.minimum) throw invalidParams(`tools/call argument "${key}" must be at least ${rule.minimum}`);
    if (rule.type === "boolean" && typeof value !== "boolean") throw invalidParams(`tools/call argument "${key}" must be boolean`);
    if (rule.type === "array" && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      throw invalidParams(`tools/call argument "${key}" must be an array of strings`);
    }
    if (rule.enum && !rule.enum.includes(value)) throw invalidParams(`tools/call argument "${key}" must be one of: ${rule.enum.join(", ")}`);
  }
}

function projectContextError(name, args) {
  if (name === "ahp_project_list") return null;
  // Project selection has precedence over cwd in the CLI too. A desktop host
  // may retain an irrelevant relative cwd while supplying the stable project
  // id, so do not reject the otherwise valid explicit selection.
  if (args.project || process.env.AHP_PROJECT) return null;
  if (args.cwd) {
    if (!path.isAbsolute(args.cwd)) {
      return 'tools/call argument "cwd" must be an absolute path inside the target Git repository';
    }
    return null;
  }
  if (git.isGitRepo(process.cwd())) return null;
  return (
    `AHP MCP is running outside a Git repository (${process.cwd()}). ` +
    'Pass the target checkout as an absolute "cwd" argument, or pass its registered "project" id/name. ' +
    'Desktop MCP servers do not inherit a chat workspace automatically.'
  );
}

function toArgv(name, a = {}) {
  assertToolArguments(name, a);
  const g = [];
  if (a.project) g.push("--project", String(a.project));
  if (a.cwd) g.push("--cwd", String(a.cwd));
  if (a.lane) g.push("--lane", String(a.lane));
  // push into the command's own argv (r), NOT g — g has already been spread
  // into r by the time these run, so appending to g here would be dropped.
  const list = (r, flag, arr) => (arr ?? []).forEach((v) => r.push(flag, String(v)));
  switch (name) {
    case "ahp_status": return ["status", ...g];
    case "ahp_pickup": return ["pickup", ...(a.full ? ["--full"] : []), ...g];
    case "ahp_project_list": return ["project", "list", ...(a.as_json ? ["--json"] : [])];
    case "ahp_lane_list": return ["lane", "list", ...(a.all ? ["--all"] : []), ...(a.as_json ? ["--json"] : []), ...g];
    case "ahp_lane_create": {
      const r = ["lane", "create", "--title", String(a.title), "--description", String(a.description), ...g];
      if (a.id) r.push("--id", String(a.id));
      list(r, "--scope", a.scope); list(r, "--alias", a.aliases);
      return r;
    }
    case "ahp_lane_edit": {
      const r = ["lane", "edit", String(a.lane)];
      if (a.project) r.push("--project", String(a.project));
      if (a.cwd) r.push("--cwd", String(a.cwd));
      if (a.title) r.push("--title", String(a.title));
      if (a.description) r.push("--description", String(a.description));
      if (a.status) r.push("--status", String(a.status));
      list(r, "--scope", a.scope); list(r, "--alias", a.aliases);
      return r;
    }
    case "ahp_verify": return ["verify", ...(a.lenient ? ["--lenient"] : []), ...g];
    case "ahp_read": {
      const r = ["read", ...g];
      if (a.since != null) r.push("--since", String(a.since));
      if (a.tail != null) r.push("--tail", String(a.tail));
      if (a.type) r.push("--type", String(a.type));
      if (a.worker) r.push("--worker", String(a.worker));
      if (a.field) r.push("--field", String(a.field));
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
      list(r, "--ref", a.refs); list(r, "--scope", a.scope);
      return r;
    }
    case "ahp_intent_promote": {
      const r = ["intent", "promote", "--id", String(a.id), "--gate", String(a.gate), "--actual", String(a.actual), ...g];
      list(r, "--commit", a.commits); list(r, "--landmine", a.landmines);
      if (a.next) r.push("--next", String(a.next));
      return r;
    }
    case "ahp_end": {
      const r = ["end", "--reason", String(a.reason), "--summary", String(a.summary), ...g];
      if (a.gate) r.push("--gate", String(a.gate));
      if (a.evidence) r.push("--evidence", String(a.evidence));
      list(r, "--finding", a.findings);
      return r;
    }
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// Worker identity: the MCP host tells us who it is in the initialize handshake
// (clientInfo.name). We use that as the default so records aren't attributed to
// "unknown". An explicit worker_id in the tool call still wins; AHP_* env vars
// still win over that.
let clientName = null;

function callTool(name, args) {
  const argv = toArgv(name, args);
  const contextError = projectContextError(name, args);
  if (contextError) return { text: contextError, isError: true };
  const env = { ...process.env };
  if (clientName) {
    // Empty inherited variables mean unspecified in normal host launchers;
    // preserve a non-empty explicit AHP_* override, otherwise use clientInfo.
    if (!env.AHP_WORKER_ID) env.AHP_WORKER_ID = clientName;
    if (!env.AHP_RUNTIME) env.AHP_RUNTIME = clientName;
  }
  const res = spawnSync(process.execPath, [AHP_BIN, ...argv], { encoding: "utf8", shell: false, env });
  const out = `${res.stdout ?? ""}${res.stderr ? `\n${res.stderr}` : ""}`.trim();
  return { text: out || "(no output)", isError: (res.status ?? 1) !== 0 };
}

// --- JSON-RPC plumbing ---------------------------------------------------

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function handle(msg) {
  if (!isObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return fail(null, -32600, "invalid request");
  }
  if (msg.method && msg.id === undefined) return; // notification
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      const c = params?.clientInfo?.name;
      // fold the host's clientInfo.name ("Claude Code", "claude-code", …) to the
      // same canonical id the CLI uses, so MCP-written and CLI-written records
      // attribute to one worker.
      if (typeof c === "string" && c.trim()) {
        const canon = canonicalWorkerId(c);
        if (canon !== "unknown") clientName = canon;
      }
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
      if (typeof name !== "string" || !name) return fail(id, -32602, "tools/call requires a tool name");
      if (args !== undefined && !isObject(args)) return fail(id, -32602, "tools/call arguments must be an object");
      const r = callTool(name, args ?? {});
      return reply(id, { content: [{ type: "text", text: r.text }], isError: r.isError });
    }
    return fail(id, -32601, `method not found: ${method}`);
  } catch (e) {
    return fail(id, e.rpcCode ?? -32603, e.message);
  }
}

export function serve() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); }
    catch { return fail(null, -32700, "parse error"); }
    handle(msg);
  });
  rl.on("close", () => process.exit(0));
}

if (import.meta.url === `file://${process.argv[1]}`) serve();
