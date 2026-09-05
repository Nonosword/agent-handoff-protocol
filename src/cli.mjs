// ahp — Agent Handoff Protocol CLI. Zero runtime dependencies.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import * as git from "./git.mjs";
import * as project from "./project.mjs";
import { storeHome } from "./paths.mjs";
import { readEntries, analyze, appendRecord } from "./worklog.mjs";
import { validateRecords } from "./validate.mjs";
import { assertCanOpen, assertCanPromote, assertCanEnd, makeSessionId, currentSessionId } from "./lifecycle.mjs";
import { renderStatus, renderPickup, renderLog } from "./render.mjs";
import { detectRuntime, canonicalWorkerId } from "./worker-detect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));

const HELP = `ahp — Agent Handoff Protocol (v${PKG.version})

  Continuity for rotated coding agents. The worklog lives in a central store
  (${storeHome()}), one file per project, keyed by the project's Git identity.
  Your project repository is never touched.

USAGE
  ahp <command> [options]

READ
  dashboard [-w] [-n S]  every project: baton, worklog state, drift. Runs from
                         anywhere. -w/--watch refreshes (default 5s, -n/--interval).
                         --json for scripts.
  status                 project, baton holder, open intents, tree/gate state
  pickup                 guided pickup: last handoff, commits since, open intents
  read [--since N] [--tail K] [--type T] [--worker ID] [--field F] [--json]
                         --field projects one field (e.g. landmines, next) flat
                         across matching records; --field hazards = landmines +
                         findings together. --tail then counts values, not records.
  log  [--worker ID]     human-readable rendering of the worklog
  verify [--lenient]     structural + lifecycle check (strict by default)
  path                   print the worklog file path for this project

WRITE  (append-only; seq and timestamp are assigned for you)
  start  --plan TEXT --gate pass|fail|not-run [--evidence TEXT] [--continues N]
  intent open   --id ID --title TEXT --intended TEXT [--ref R]... [--scope S]...
  intent promote --id ID --commit SHA... --gate pass|fail|not-run --actual TEXT
                 [--landmine TEXT]... [--next TEXT]
  end  --reason limit|task-done|blocked|handoff-requested --summary TEXT
       --gate pass|fail|not-run [--evidence ...] [--finding TEXT]...

PROJECTS
  project list
  project current
  project add [--name NAME] [--path DIR]
  project rename <id|name> <new-name>
  project forget <id|name>

MAINTENANCE
  compact [--keep N]     archive old sessions, keep the last N (default 3)
  upgrade [--check]      git pull this checkout, then re-run the installer so
                         every host picks up the new skill / MCP registration.
                         --check only reports whether an update is available.

GLOBAL
  --project <id|name>    override project detection (also AHP_PROJECT)
  --cwd <dir>            resolve the project from this directory
  --version | -h/--help

WORKER IDENTITY  is taken from --worker-id/--model/--runtime, else the
  AHP_WORKER_ID / AHP_MODEL / AHP_RUNTIME env vars, else the last handoff.start.
`;

export async function main(argv = process.argv.slice(2)) {
  try {
    return await run(argv);
  } catch (e) {
    process.stderr.write(`ahp: ${e.message}\n`);
    return 1;
  }
}

async function run(argv) {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    process.stdout.write(`${PKG.version}\n`);
    return 0;
  }
  // `ahp dashboard --help` used to die with "Unknown option '--help'": the
  // per-command parsers are strict and none of them declared it. There is one
  // reference, so route any -h/--help to it. (No command uses -h as a short.)
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const [cmd, ...rest] = argv;
  const home = storeHome();

  switch (cmd) {
    case "dashboard": case "dash": case "overview": {
      const { values } = parse(rest, {
        json: { type: "boolean" },
        watch: { type: "boolean", short: "w" },
        interval: { type: "string", short: "n" }
      });
      const { dashboard } = await import("./dashboard.mjs");
      return dashboard({ home, json: values.json, watch: values.watch, interval: values.interval ? Number(values.interval) : 5 });
    }
    case "status": return cmdStatus(rest, home);
    case "pickup": return cmdPickup(rest, home);
    case "read": return cmdRead(rest, home);
    case "log": return cmdLog(rest, home);
    case "verify": return cmdVerify(rest, home);
    case "path": return cmdPath(rest, home);
    case "start": return cmdStart(rest, home);
    case "intent": return cmdIntent(rest, home);
    case "end": return cmdEnd(rest, home);
    case "project": return cmdProject(rest, home);
    case "compact": return cmdCompact(rest, home);
    case "upgrade": return cmdUpgrade(rest);
    default:
      process.stderr.write(`ahp: unknown command "${cmd}" — try \`ahp help\`\n`);
      return 2;
  }
}

// --- helpers ---------------------------------------------------------------

const GLOBAL_OPTS = {
  project: { type: "string" },
  cwd: { type: "string" },
  "worker-id": { type: "string" },
  model: { type: "string" },
  runtime: { type: "string" }
};

function parse(rest, options, { allowPositionals = false } = {}) {
  return parseArgs({ args: rest, options: { ...GLOBAL_OPTS, ...options }, allowPositionals, strict: true });
}

function resolveProject(values) {
  const cwd = values.cwd ? path.resolve(values.cwd) : process.cwd();
  return project.resolve({ cwd, project: values.project ?? null, home: storeHome() });
}

function gitView(root) {
  const cwd = root ?? process.cwd();
  return {
    root,
    branch: root ? git.branch(cwd) : null,
    short: root ? git.shortCommit(cwd) : null,
    head: root ? git.headCommit(cwd) : null,
    clean: root ? git.isClean(cwd) : null,
    dirty: root ? git.dirtyPaths(cwd) : []
  };
}

function worker(values, fallbackFromLog) {
  const rawId = values["worker-id"] || process.env.AHP_WORKER_ID;
  const model = values.model || process.env.AHP_MODEL;
  let runtime = values.runtime || process.env.AHP_RUNTIME;
  if (rawId || model || runtime) {
    // canonicalise the id the record is attributed to; if the id the caller
    // gave was really a runtime spelling ("Claude Code"), keep it as `runtime`
    // so the detail is not lost.
    const id = canonicalWorkerId({ id: rawId, model, runtime });
    const rawNorm = rawId ? String(rawId).trim().toLowerCase().replace(/\s+/g, "-") : null;
    if (!runtime && rawNorm && rawNorm !== id) runtime = rawNorm;
    return { id, ...(model ? { model } : {}), ...(runtime ? { runtime } : {}) };
  }
  if (fallbackFromLog && canonicalWorkerId(fallbackFromLog) !== "unknown") return fallbackFromLog;
  const detected = detectRuntime();
  if (detected) return { id: detected };
  return fallbackFromLog ?? { id: "unknown" };
}

function stateFrom(g, gate, evidence) {
  return {
    commit: g.head ?? "unknown",
    gate: gate ?? "not-run",
    ...(evidence ? { gateEvidence: evidence } : {}),
    treeClean: g.clean === null ? false : g.clean,
    verifiedBy: "self"
  };
}

function requireProjectGit(proj) {
  if (!proj.roots?.length && proj.source && proj.source.startsWith("explicit")) {
    // explicit project not tied to a checkout here: git-less operation
    return null;
  }
  const root = proj.roots?.[0] ?? git.topLevel(process.cwd());
  return root && git.isGitRepo(root) ? root : (git.isGitRepo(process.cwd()) ? git.topLevel(process.cwd()) : null);
}

// --- read commands -------------------------------------------------------

function cmdStatus(rest, home) {
  const { values } = parse(rest, { json: { type: "boolean" } });
  const proj = resolveProject(values);
  const root = requireProjectGit(proj);
  const g = gitView(root);
  let analysis;
  try { analysis = analyze(readEntries(proj.worklog)); }
  catch (e) { process.stderr.write(`ahp: ${e.message}\n`); return 1; }
  if (values.json) {
    process.stdout.write(JSON.stringify({
      project: { id: proj.id, name: proj.name },
      baton: analysis.baton,
      openIntents: analysis.openIntents.map((i) => i.intentId),
      lastSeq: analysis.lastSeq,
      git: { head: g.head ?? null, clean: g.clean, dirty: g.dirty },
      verify: {
        errors: analysis.validation.errors,
        warnings: analysis.validation.warnings,
        notes: analysis.validation.notes
      }
    }) + "\n");
    return analysis.validation.errors.length ? 1 : 0;
  }
  if (proj.source === "autoregistered") process.stdout.write(`(auto-registered project "${proj.name}" [${proj.id}])\n\n`);
  process.stdout.write(renderStatus({ project: proj, git: g, analysis }) + "\n");
  return analysis.validation.errors.length ? 1 : 0;
}

function reconcileView(analysis, sinceCommits) {
  const commitToIntent = new Map();
  const commitToIntentLong = new Map();
  for (const p of analysis.promotes) {
    for (const c of p.commits ?? []) {
      commitToIntent.set(c, p.intentId);
      commitToIntentLong.set(c.slice(0, 7), p.intentId);
    }
  }
  const sinceShorts = new Set(sinceCommits.map((c) => c.short));
  const danglingPromotes = analysis.promotes.filter(
    (p) => (p.commits ?? []).length && !(p.commits ?? []).some((c) => sinceShorts.has(c) || sinceShorts.has(c.slice(0, 7)))
  );
  return { commitToIntent, commitToIntentLong, danglingPromotes };
}

function cmdPickup(rest, home) {
  const { values } = parse(rest, {});
  const proj = resolveProject(values);
  const root = requireProjectGit(proj);
  const g = gitView(root);
  const analysis = analyze(readEntries(proj.worklog));
  let sinceCommits = [];
  if (root && analysis.lastStart?.base?.commit && analysis.lastStart.base.commit !== "unknown") {
    if (git.commitExists(root, analysis.lastStart.base.commit)) {
      sinceCommits = git.logRange(root, analysis.lastStart.base.commit, "HEAD");
    }
  }
  const reconcile = reconcileView(analysis, sinceCommits);
  // "you've been here before" — resolve the prospective picker's identity and
  // find where it last held the baton, without moving the pickup anchor.
  const meId = workerId(worker(values));
  let selfHistory = null;
  if (meId && meId !== "unknown") {
    const mine = analysis.records.filter((r) => r.type === "handoff.start" && workerId(r.worker) === meId);
    if (mine.length) {
      const lastMine = mine[mine.length - 1];
      const handoffsSince = analysis.records.filter((r) => r.type === "handoff.start" && r.seq > lastMine.seq).length;
      // only worth saying when someone else has held the baton since
      if (handoffsSince >= 1) selfHistory = { seq: lastMine.seq, at: lastMine.at, handoffsSince, meId };
    }
  }
  process.stdout.write(renderPickup({ project: proj, git: g, analysis, sinceCommits, reconcile, selfHistory }) + "\n");
  return 0;
}

// The identity used for attribution and "is this my own earlier turn" — folded
// to one canonical spelling so a session is never split across `claude` /
// `claude-code`. The `worker` object keeps any finer `runtime` untouched.
function workerId(w) {
  return canonicalWorkerId(w);
}

function filterByWorker(records, want) {
  if (!want) return records;
  const canon = canonicalWorkerId(want);
  return records.filter((r) => workerId(r.worker) === canon);
}

// `hazards` is a pseudo-field: landmines (intent.promote) and findings
// (handoff.end) are both "what the next worker must know" (SPEC §5.3/§5.5),
// so pulling them together answers "what should I watch out for" in one query.
// Any other --field is read straight off the record (`next`, `refs`, `actual`,
// `commits`, … — whatever that record type carries; absent fields yield nothing).
function projectField(records, field) {
  const names = field === "hazards" ? ["landmines", "findings"] : [field];
  const out = [];
  for (const r of records) {
    for (const name of names) {
      const v = r[name];
      if (v == null) continue;
      for (const item of Array.isArray(v) ? v : [v]) {
        out.push({ seq: r.seq, at: r.at, type: r.type, field: name, value: item });
      }
    }
  }
  return out;
}

function cmdRead(rest, home) {
  const { values } = parse(rest, {
    since: { type: "string" }, tail: { type: "string" }, type: { type: "string" },
    worker: { type: "string" }, field: { type: "string" }, json: { type: "boolean" }
  });
  const proj = resolveProject(values);
  let records = readEntries(proj.worklog).map((e) => e.record);
  if (values.since) records = records.filter((r) => r.seq > Number(values.since));
  if (values.type) records = records.filter((r) => r.type === values.type);
  if (values.worker) records = filterByWorker(records, values.worker);
  if (values.field) {
    let items = projectField(records, values.field);
    if (values.tail) items = items.slice(-Number(values.tail));
    if (values.json) {
      for (const it of items) process.stdout.write(`${JSON.stringify(it)}\n`);
    } else if (items.length === 0) {
      process.stdout.write("(no matching values)\n");
    } else {
      for (const it of items) process.stdout.write(`seq ${it.seq}  ${it.value}\n`);
    }
    return 0;
  }
  if (values.tail) records = records.slice(-Number(values.tail));
  if (values.json) {
    for (const r of records) process.stdout.write(`${JSON.stringify(r)}\n`);
  } else {
    process.stdout.write(renderLog(records) + "\n");
  }
  return 0;
}

function cmdLog(rest, home) {
  const { values } = parse(rest, { worker: { type: "string" } });
  const proj = resolveProject(values);
  let records = readEntries(proj.worklog).map((e) => e.record);
  if (values.worker) records = filterByWorker(records, values.worker);
  process.stdout.write((records.length ? renderLog(records) : "(no matching records)") + "\n");
  return 0;
}

function cmdVerify(rest, home) {
  // strict is the default: a quality warning fails verify. `--lenient` downgrades
  // warnings to advisory (for an old or knowingly-messy log). `--strict` is still
  // accepted as a no-op. Notes are never fatal.
  const { values } = parse(rest, { strict: { type: "boolean" }, lenient: { type: "boolean" } });
  const proj = resolveProject(values);
  let entries;
  try { entries = readEntries(proj.worklog); }
  catch (e) { process.stderr.write(`error: ${e.message}\n`); return 1; }
  const { errors, warnings, notes, stats } = validateRecords(entries);
  for (const n of notes) process.stdout.write(`note: ${n}\n`);
  // warnings are fatal unless --lenient; when fatal they go to stderr with the
  // errors, so a caller that captures stderr for failures sees them.
  const warnStream = values.lenient ? process.stdout : process.stderr;
  const warnLabel = values.lenient ? "warning" : "error";
  for (const w of warnings) warnStream.write(`${warnLabel}: ${w}\n`);
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  if (errors.length || (!values.lenient && warnings.length)) return 1;
  process.stdout.write(`ok: ${stats.records} record(s), ${stats.promoted} promoted, ${stats.open} open, ${warnings.length} warning(s), ${notes.length} note(s)\n`);
  return 0;
}

async function cmdUpgrade(rest) {
  const { values } = parse(rest, { check: { type: "boolean" } });
  const { upgrade } = await import("./upgrade.mjs");
  return upgrade({ check: !!values.check });
}

function cmdPath(rest, home) {
  const { values } = parse(rest, {});
  const proj = resolveProject(values);
  process.stdout.write(`${proj.worklog}\n`);
  return 0;
}

// --- write commands -----------------------------------------------------

function cmdStart(rest, home) {
  const { values } = parse(rest, {
    plan: { type: "string" }, gate: { type: "string" }, evidence: { type: "string" }, continues: { type: "string" }
  });
  if (!values.plan) throw new Error("start requires --plan");
  assertGate(values.gate, false);
  const proj = resolveProject(values);
  const root = requireProjectGit(proj);
  const g = gitView(root);
  const analysis = analyze(readEntries(proj.worklog));
  const continuesFrom = values.continues !== undefined
    ? Number(values.continues)
    : (analysis.lastStart ? analysis.lastStart.seq : null);
  if (analysis.batonHeld) {
    const w = analysis.batonWorker;
    process.stderr.write(`note: previous worker ${typeof w === "string" ? w : w?.id} wrote no handoff.end — assuming a cutoff and continuing\n`);
  }
  const rec = appendRecord(proj.worklog, proj.lock, {
    type: "handoff.start",
    worker: worker(values),
    continuesFrom,
    base: stateFrom(g, values.gate, values.evidence),
    plan: values.plan
  }, { derive: (full) => ({ sessionId: makeSessionId(full.worker, full.at, full.seq) }) });
  process.stdout.write(`handoff.start seq ${rec.seq} — baton taken by ${labelWorker(rec.worker)} at ${rec.base.commit.slice(0, 12)} (gate ${rec.base.gate}) · session ${rec.sessionId}\n`);
  if (rec.base.gate === "not-run") process.stdout.write("reminder: gate=not-run — run the project's gate and record the result in your first intent.promote\n");
  return 0;
}

function cmdIntent(rest, home) {
  const sub = rest[0];
  if (sub === "open") return intentOpen(rest.slice(1), home);
  if (sub === "promote") return intentPromote(rest.slice(1), home);
  throw new Error("intent requires a subcommand: open | promote");
}

function intentOpen(rest, home) {
  const { values } = parse(rest, {
    id: { type: "string" }, title: { type: "string" }, intended: { type: "string" },
    ref: { type: "string", multiple: true }, scope: { type: "string", multiple: true }
  });
  for (const f of ["id", "title", "intended"]) if (!values[f]) throw new Error(`intent open requires --${f}`);
  const proj = resolveProject(values);
  const analysis = analyze(readEntries(proj.worklog));
  assertCanOpen(analysis.records, values.id);
  const sid = currentSessionId(analysis);
  const rec = appendRecord(proj.worklog, proj.lock, {
    type: "intent.open",
    worker: worker(values, analysis.lastStart?.worker),
    intentId: values.id,
    title: values.title,
    intended: values.intended,
    ...(sid ? { sessionId: sid } : {}),
    ...(values.ref?.length ? { refs: values.ref } : {}),
    ...(values.scope?.length ? { scope: values.scope } : {})
  });
  process.stdout.write(`intent.open seq ${rec.seq} — ${values.id}\n`);
  return 0;
}

function intentPromote(rest, home) {
  const { values } = parse(rest, {
    id: { type: "string" }, commit: { type: "string", multiple: true }, gate: { type: "string" },
    actual: { type: "string" }, landmine: { type: "string", multiple: true }, next: { type: "string" }
  });
  for (const f of ["id", "actual"]) if (!values[f]) throw new Error(`intent promote requires --${f}`);
  assertGate(values.gate, false);
  const commits = values.commit ?? [];
  const proj = resolveProject(values);
  const analysis = analyze(readEntries(proj.worklog));
  assertCanPromote(analysis.records, { id: values.id, gate: values.gate, commits, landmines: values.landmine ?? [] });
  const sid = currentSessionId(analysis);
  const rec = appendRecord(proj.worklog, proj.lock, {
    type: "intent.promote",
    worker: worker(values, analysis.lastStart?.worker),
    intentId: values.id,
    commits,
    gate: values.gate,
    actual: values.actual,
    ...(sid ? { sessionId: sid } : {}),
    ...(values.landmine?.length ? { landmines: values.landmine } : {}),
    ...(values.next ? { next: values.next } : {})
  });
  process.stdout.write(`intent.promote seq ${rec.seq} — ${values.id} → ${commits.join(", ") || "(wip)"} [gate ${values.gate}]\n`);
  return 0;
}

function cmdEnd(rest, home) {
  const { values } = parse(rest, {
    reason: { type: "string" }, summary: { type: "string" }, gate: { type: "string" },
    evidence: { type: "string" }, finding: { type: "string", multiple: true }
  });
  for (const f of ["reason", "summary"]) if (!values[f]) throw new Error(`end requires --${f}`);
  if (!["limit", "task-done", "blocked", "handoff-requested"].includes(values.reason)) {
    throw new Error("--reason must be limit | task-done | blocked | handoff-requested");
  }
  assertGate(values.gate, false);
  const proj = resolveProject(values);
  const root = requireProjectGit(proj);
  const g = gitView(root);
  const analysis = analyze(readEntries(proj.worklog));
  const findings = values.finding ?? [];
  const gate = values.gate ?? "not-run";
  assertCanEnd({ gate, findings });
  const sid = currentSessionId(analysis);
  const rec = appendRecord(proj.worklog, proj.lock, {
    type: "handoff.end",
    worker: worker(values, analysis.lastStart?.worker),
    reason: values.reason,
    end: stateFrom(g, values.gate, values.evidence),
    summary: values.summary,
    openIntents: analysis.openIntents.map((i) => i.intentId),
    ...(sid ? { sessionId: sid } : {}),
    ...(findings.length ? { findings } : {})
  });
  process.stdout.write(`handoff.end seq ${rec.seq} — ${values.reason} at ${rec.end.commit.slice(0, 12)} (gate ${rec.end.gate})\n`);
  if (analysis.openIntents.length) {
    process.stdout.write(`carried ${analysis.openIntents.length} open intent(s): ${analysis.openIntents.map((i) => i.intentId).join(", ")}\n`);
  }
  return 0;
}

// --- project commands --------------------------------------------------

function cmdProject(rest, home) {
  const sub = rest[0];
  const { values, positionals } = parse(rest.slice(1), { name: { type: "string" }, path: { type: "string" } }, { allowPositionals: true });
  if (sub === "list") {
    const items = project.list(home);
    if (!items.length) { process.stdout.write("(no projects registered)\n"); return 0; }
    for (const p of items) {
      process.stdout.write(`${p.name}\t[${p.id}]\t${p.remote ?? p.roots[0] ?? ""}\n`);
    }
    return 0;
  }
  if (sub === "current") {
    const proj = resolveProject(values);
    process.stdout.write(`${proj.name}\t[${proj.id}]\t(${proj.source})\n${proj.worklog}\n`);
    return 0;
  }
  if (sub === "add") {
    const cwd = values.path ? path.resolve(values.path) : process.cwd();
    const reg = project.register({ cwd, home, name: values.name ?? null });
    process.stdout.write(`registered ${reg.name} [${reg.id}]\n  worklog: ${reg.worklog}\n`);
    return 0;
  }
  if (sub === "rename") {
    const [target, newName] = positionals;
    if (!target || !newName) throw new Error("usage: ahp project rename <id|name> <new-name>");
    const id = project.rename(home, target, newName);
    process.stdout.write(`renamed [${id}] → ${newName}\n`);
    return 0;
  }
  if (sub === "forget") {
    const [target] = positionals;
    if (!target) throw new Error("usage: ahp project forget <id|name>");
    const id = project.forget(home, target);
    process.stdout.write(`forgot [${id}] (the worklog file was left in place)\n`);
    return 0;
  }
  throw new Error("project requires: list | current | add | rename | forget");
}

// --- compaction -------------------------------------------------------

function cmdCompact(rest, home) {
  const { values } = parse(rest, { keep: { type: "string" } });
  const keep = values.keep ? Number(values.keep) : 3;
  const proj = resolveProject(values);
  const entries = readEntries(proj.worklog);
  if (entries.length === 0) { process.stdout.write("(nothing to compact)\n"); return 0; }

  // session boundaries = handoff.start indices
  const startIdx = entries.map((e, i) => (e.record.type === "handoff.start" ? i : -1)).filter((i) => i >= 0);
  if (startIdx.length <= keep) { process.stdout.write(`only ${startIdx.length} session(s); keeping all\n`); return 0; }

  const cutIdx = startIdx[startIdx.length - keep];
  const promotedIds = new Set(entries.filter((e) => e.record.type === "intent.promote").map((e) => e.record.intentId));
  // records to KEEP live: everything from cutIdx on, plus any earlier intent.open not yet promoted
  const keptEarlyOpen = entries.slice(0, cutIdx).filter((e) => e.record.type === "intent.open" && !promotedIds.has(e.record.intentId));
  const archived = entries.slice(0, cutIdx).filter((e) => !keptEarlyOpen.includes(e));
  const live = [...keptEarlyOpen, ...entries.slice(cutIdx)];

  const first = archived[0].record.seq;
  const last = archived[archived.length - 1].record.seq;
  const archDir = path.join(proj.dir, "archive");
  fs.mkdirSync(archDir, { recursive: true });
  const archFile = path.join(archDir, `${first}-${last}.jsonl`);
  fs.writeFileSync(archFile, archived.map((e) => JSON.stringify(e.record)).join("\n") + "\n");
  fs.writeFileSync(proj.worklog, live.map((e) => JSON.stringify(e.record)).join("\n") + "\n");
  process.stdout.write(`archived ${archived.length} record(s) (seq ${first}-${last}) → ${archFile}\nlive worklog: ${live.length} record(s)\n`);
  return 0;
}

// --- misc -------------------------------------------------------------

function assertGate(v, allowUndefined) {
  if (v === undefined) { if (allowUndefined) return; throw new Error("--gate is required (pass | fail | not-run)"); }
  if (!["pass", "fail", "not-run"].includes(v)) throw new Error("--gate must be pass | fail | not-run");
}

function labelWorker(w) {
  return typeof w === "string" ? w : (w?.id ?? "?");
}
