// ahp — Agent Handoff Protocol CLI. Zero runtime dependencies.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import * as git from "./git.mjs";
import * as project from "./project.mjs";
import * as lanes from "./lanes.mjs";
import { storeHome } from "./paths.mjs";
import { readEntries, analyze, appendRecord, acquireLock, releaseLock, writeFileAtomic } from "./worklog.mjs";
import { validateRecords } from "./validate.mjs";
import { assertBatonOwner, assertCanOpen, assertCanPromote, assertCanEnd, makeSessionId, currentSessionId, project as projectState } from "./lifecycle.mjs";
import { renderStatus, renderPickup, renderLog } from "./render.mjs";
import { detectRuntime, canonicalWorkerId } from "./worker-detect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));

const HELP = `ahp — Agent Handoff Protocol (v${PKG.version})

  Continuity for rotated coding agents. The worklog lives in a central store
  (${storeHome()}), one append-only worklog per Lane, grouped by Git project.
  Your project repository is never touched.

USAGE
  ahp <command> [options]

READ
  dashboard [-w]         every project and Lane: baton + worklog state. Runs from
                         anywhere. -w redraws immediately when the local AHP store
                         changes; it does not poll or fetch.
                         --json for scripts.
  status                 selected Lane, baton holder, open intents, tree/gate state
  pickup [--full]        compact handoff, commit and open-intent summary; --full expands all
  read [--since N] [--tail K] [--type T] [--worker ID] [--field F] [--json]
                         --field projects one field (e.g. landmines, next) flat
                         across matching records; --field hazards = landmines +
                         findings together. --tail then counts values, not records.
  log  [--worker ID]     human-readable rendering of the selected Lane worklog
  verify [--lenient]     structural + lifecycle check (strict by default)
  path                   print the selected Lane worklog path

WRITE  (append-only; seq and timestamp are assigned for you)
  start  --plan TEXT --gate pass|fail|not-run [--evidence TEXT] [--continues N]
  intent open   --id ID --title TEXT --intended TEXT [--ref R]... [--scope S]...
  intent promote --id ID --commit SHA... --gate pass|fail|not-run --actual TEXT
                 [--landmine TEXT]... [--next TEXT]
  end  --reason limit|task-done|blocked|handoff-requested --summary TEXT
       --gate pass|fail|not-run [--evidence ...] [--finding TEXT]...

LANES
  lane list [--json]
  lane create --title TEXT --description TEXT [--id ID] [--scope S]... [--alias A]...
  lane edit <id> [--title TEXT] [--description TEXT] [--scope S]... [--alias A]...\n                 [--status active|blocked|done|archived]

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
  --lane <id|name>       select an existing Lane (also AHP_LANE)
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
        watch: { type: "boolean", short: "w" }
      });
      const { dashboard } = await import("./dashboard.mjs");
      return dashboard({
        home,
        version: PKG.version,
        json: values.json,
        watch: values.watch
      });
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
    case "lane": return cmdLane(rest, home);
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
  lane: { type: "string" },
  cwd: { type: "string" },
  "worker-id": { type: "string" },
  model: { type: "string" },
  runtime: { type: "string" }
};

function parse(rest, options, { allowPositionals = false } = {}) {
  return parseArgs({ args: rest, options: { ...GLOBAL_OPTS, ...options }, allowPositionals, strict: true });
}

function resolveProject(values, { registerMissing = false } = {}) {
  const cwd = values.cwd ? path.resolve(values.cwd) : process.cwd();
  return project.resolve({ cwd, project: values.project ?? null, home: storeHome(), registerMissing });
}

function gitView(root) {
  const cwd = root ?? process.cwd();
  const head = root ? git.headView(cwd) : { branch: null, short: null };
  const tree = root ? git.workingTree(cwd) : { clean: null, dirty: [] };
  return { root, branch: head.branch, short: head.short, head: root ? git.headCommit(cwd) : null, ...tree };
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
  if (proj.operationRoot && git.isGitRepo(proj.operationRoot)) return proj.operationRoot;
  if (!proj.roots?.length && proj.source && proj.source.startsWith("explicit")) {
    // explicit project not tied to a checkout here: git-less operation
    return null;
  }
  const root = proj.roots?.[0] ?? git.topLevel(process.cwd());
  return root && git.isGitRepo(root) ? root : (git.isGitRepo(process.cwd()) ? git.topLevel(process.cwd()) : null);
}

function laneTarget(proj, lane) {
  return { ...proj, laneProject: proj, lane, worklog: lane.worklog, lock: lane.lock };
}

function assertLaneWritable(proj) {
  if (!proj.lane) return;
  const current = lanes.find(proj.laneProject ?? proj, proj.lane.id);
  if (!current || current.status === "archived") {
    throw new Error(`Lane "${proj.lane.id}" is archived — edit its status or choose another Lane`);
  }
}

function currentSessionPatch(entries) {
  const sessionId = currentSessionId(projectState(entries.map((entry) => entry.record)));
  return sessionId ? { sessionId } : {};
}

function resolveTarget(values, { registerMissing = false, autoPlan = null } = {}) {
  const proj = resolveProject(values, { registerMissing });
  const wanted = values.lane || process.env.AHP_LANE;
  if (wanted) {
    const lane = lanes.find(proj, wanted);
    if (!lane) throw new Error(`unknown Lane "${wanted}" — run \`ahp lane list\``);
    if (registerMissing && lane.status === "archived") throw new Error(`Lane "${lane.id}" is archived — edit its status or choose another Lane`);
    return laneTarget(proj, lane);
  }
  const candidates = lanes.list(proj, { includeArchived: false });
  if (candidates.length === 0) {
    if (registerMissing && autoPlan) {
      const title = String(autoPlan).trim().slice(0, 80);
      const lane = lanes.create(proj, { title, description: String(autoPlan).trim() });
      process.stdout.write(`lane.created ${lane.id} — ${lane.title}\n`);
      return laneTarget(proj, lane);
    }
    if (registerMissing) {
      throw new Error("no Lane exists — run `ahp start` to create one from its plan, or `ahp lane create`");
    }
    return proj;
  }
  if (candidates.length === 1) {
    const lane = candidates[0];
    return laneTarget(proj, lane);
  }
  const me = canonicalWorkerId(worker(values));
  const heldByMe = candidates.filter((lane) => {
    try {
      const state = analyze(readEntries(lane.worklog));
      return state.batonHeld && canonicalWorkerId(state.batonWorker) === me;
    } catch { return false; }
  });
  if (heldByMe.length === 1) {
    const lane = heldByMe[0];
    return laneTarget(proj, lane);
  }
  throw new Error(lanes.formatChoices(candidates));
}

// --- read commands -------------------------------------------------------

function cmdStatus(rest, home) {
  const { values } = parse(rest, { json: { type: "boolean" } });
  const proj = resolveTarget(values);
  const root = requireProjectGit(proj);
  const g = gitView(root);
  let analysis;
  try { analysis = analyze(readEntries(proj.worklog)); }
  catch (e) { process.stderr.write(`ahp: ${e.message}\n`); return 1; }
  if (values.json) {
    process.stdout.write(JSON.stringify({
      project: { id: proj.id, name: proj.name },
      lane: proj.lane ? { id: proj.lane.id, title: proj.lane.title, status: proj.lane.status } : null,
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
  process.stdout.write(renderStatus({ project: proj, git: g, analysis }) + "\n");
  return analysis.validation.errors.length ? 1 : 0;
}

function relatedPromotionSources(proj, analysis, hasCommits) {
  const sources = [{ laneId: proj.lane?.id ?? null, promotions: analysis.promotes }];
  const unreadLanes = [];
  if (!hasCommits || !proj.lane) return { sources, unreadLanes };
  for (const lane of lanes.list(proj.laneProject ?? proj)) {
    if (lane.id === proj.lane.id) continue;
    try {
      const promotions = readEntries(lane.worklog).map((entry) => entry.record)
        .filter((record) => record.type === "intent.promote");
      sources.push({ laneId: lane.id, promotions });
    } catch {
      unreadLanes.push(lane.id);
    }
  }
  return { sources, unreadLanes };
}

function reconcileView(analysis, root, { deep = false, sources, unreadLanes = [] } = {}) {
  const commitToIntent = new Map();
  const commitToIntentLong = new Map();
  for (const source of sources) {
    for (const promotion of source.promotions) {
      for (const commit of promotion.commits ?? []) {
        const label = source.laneId ? source.laneId + "/" + promotion.intentId : promotion.intentId;
        const add = (map, key) => {
          const values = map.get(key) ?? [];
          values.push(label);
          map.set(key, values);
        };
        add(commitToIntent, commit);
        add(commitToIntentLong, commit.slice(0, 7));
      }
    }
  }
  const danglingPromotes = deep && root
    ? analysis.promotes.filter((promotion) => (promotion.commits ?? []).length && !(promotion.commits ?? []).some((commit) => git.isAncestor(root, commit, "HEAD")))
    : [];
  return { commitToIntent, commitToIntentLong, danglingPromotes, unreadLanes };
}

function cmdPickup(rest, home) {
  const { values } = parse(rest, { full: { type: "boolean" } });
  const proj = resolveTarget(values);
  const root = requireProjectGit(proj);
  const g = gitView(root);
  const analysis = analyze(readEntries(proj.worklog));
  let sinceCommits = [];
  if (root && analysis.lastStart?.base?.commit && analysis.lastStart.base.commit !== "unknown") {
    if (git.commitExists(root, analysis.lastStart.base.commit)) {
      sinceCommits = git.logRange(root, analysis.lastStart.base.commit, "HEAD");
    }
  }
  const related = relatedPromotionSources(proj, analysis, sinceCommits.length > 0);
  const reconcile = reconcileView(analysis, root, { deep: !!values.full, ...related });
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
  process.stdout.write(renderPickup({ project: proj, git: g, analysis, sinceCommits, reconcile, selfHistory, full: !!values.full }) + "\n");
  if (analysis.validation.errors.length) {
    process.stderr.write(`error: selected worklog has ${analysis.validation.errors.length} validation error(s); repair it before starting work\n`);
    return 1;
  }
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
  const proj = resolveTarget(values);
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
  const proj = resolveTarget(values);
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
  const proj = resolveTarget(values);
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
  const proj = resolveTarget(values);
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
  const proj = resolveTarget(values, { registerMissing: true, autoPlan: values.plan });
  const root = requireProjectGit(proj);
  const g = gitView(root);
  const analysis = analyze(readEntries(proj.worklog));
  const continuesFrom = values.continues !== undefined ? Number(values.continues) : undefined;
  if (analysis.batonHeld) {
    const w = analysis.batonWorker;
    process.stderr.write(`note: previous worker ${typeof w === "string" ? w : w?.id} wrote no handoff.end — assuming a cutoff and continuing\n`);
  }
  const rec = appendRecord(proj.worklog, proj.lock, {
    type: "handoff.start",
    worker: worker(values),
    ...(continuesFrom === undefined ? {} : { continuesFrom }),
    base: stateFrom(g, values.gate, values.evidence),
    plan: values.plan
  }, { derive: (full, entries) => {
    const current = projectState(entries.map((entry) => entry.record));
    return {
      sessionId: makeSessionId(full.worker, full.at, full.seq),
      ...(full.continuesFrom === undefined ? { continuesFrom: current.lastStart?.seq ?? null } : {})
    };
  }, precondition: () => assertLaneWritable(proj) });
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
  const proj = resolveTarget(values, { registerMissing: true });
  const actor = worker(values);
  const rec = appendRecord(proj.worklog, proj.lock, {
    type: "intent.open",
    worker: actor,
    intentId: values.id,
    title: values.title,
    intended: values.intended,
    ...(values.ref?.length ? { refs: values.ref } : {}),
    ...(values.scope?.length ? { scope: values.scope } : {})
  }, {
    precondition: (records) => {
      assertLaneWritable(proj);
      assertCanOpen(records, values.id);
      assertBatonOwner(records, actor);
    },
    derive: (_full, entries) => currentSessionPatch(entries)
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
  const proj = resolveTarget(values, { registerMissing: true });
  const actor = worker(values);
  const rec = appendRecord(proj.worklog, proj.lock, {
    type: "intent.promote",
    worker: actor,
    intentId: values.id,
    commits,
    gate: values.gate,
    actual: values.actual,
    ...(values.landmine?.length ? { landmines: values.landmine } : {}),
    ...(values.next ? { next: values.next } : {})
  }, {
    precondition: (records) => {
      assertLaneWritable(proj);
      assertCanPromote(records, { id: values.id, gate: values.gate, commits, landmines: values.landmine ?? [] });
      assertBatonOwner(records, actor);
    },
    derive: (_full, entries) => currentSessionPatch(entries)
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
  const proj = resolveTarget(values, { registerMissing: true });
  const root = requireProjectGit(proj);
  const g = gitView(root);
  const findings = values.finding ?? [];
  const gate = values.gate ?? "not-run";
  assertCanEnd({ gate, findings });
  const actor = worker(values);
  const rec = appendRecord(proj.worklog, proj.lock, {
    type: "handoff.end",
    worker: actor,
    reason: values.reason,
    end: stateFrom(g, values.gate, values.evidence),
    summary: values.summary,
    ...(findings.length ? { findings } : {})
  }, {
    precondition: (records) => { assertLaneWritable(proj); assertBatonOwner(records, actor); },
    derive: (_full, entries) => {
      const state = projectState(entries.map((entry) => entry.record));
      return { ...currentSessionPatch(entries), openIntents: state.openIntents.map((intent) => intent.intentId) };
    }
  });
  process.stdout.write(`handoff.end seq ${rec.seq} — ${values.reason} at ${rec.end.commit.slice(0, 12)} (gate ${rec.end.gate})\n`);
  if (rec.openIntents.length) {
    process.stdout.write(`carried ${rec.openIntents.length} open intent(s): ${rec.openIntents.join(", ")}\n`);
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
    process.stdout.write(proj.name + "\t[" + proj.id + "]\t(" + proj.source + ")\n" + proj.worklog + "\n");
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

// --- Lane commands -----------------------------------------------------

function cmdLane(rest, home) {
  const sub = rest[0];
  const { values, positionals } = parse(rest.slice(1), {
    id: { type: "string" }, title: { type: "string" }, description: { type: "string" },
    status: { type: "string" }, scope: { type: "string", multiple: true },
    alias: { type: "string", multiple: true }, json: { type: "boolean" }
  }, { allowPositionals: true });
  const proj = resolveProject(values, { registerMissing: sub === "create" });
  if (sub === "list") {
    const items = lanes.list(proj);
    if (values.json) {
      process.stdout.write(JSON.stringify(items.map(({ worklog, lock, ...lane }) => lane)) + "\n");
      return 0;
    }
    if (!items.length) { process.stdout.write("(no Lanes; first start creates one from its plan)\n"); return 0; }
    for (const lane of items) {
      let state;
      try { state = analyze(readEntries(lane.worklog)); } catch { state = null; }
      const baton = state?.batonHeld ? "held by " + labelWorker(state.batonWorker) : "free";
      process.stdout.write(lane.id + "\t" + lane.title + "\t[" + lane.status + "]\t" + baton + "\n");
      if (lane.description) process.stdout.write("  " + lane.description + "\n");
      if (lane.scope.length) process.stdout.write("  scope: " + lane.scope.join(", ") + "\n");
      if (lane.aliases.length) process.stdout.write("  aliases: " + lane.aliases.join(", ") + "\n");
    }
    return 0;
  }
  if (sub === "create") {
    const lane = lanes.create(proj, { id: values.id, title: values.title, description: values.description, scope: values.scope, aliases: values.alias });
    process.stdout.write("lane.created " + lane.id + " — " + lane.title + "\n");
    return 0;
  }
  if (sub === "edit") {
    const wanted = positionals[0];
    if (!wanted) throw new Error("usage: ahp lane edit <id> [--title ... --description ... --status ...]");
    const lane = lanes.edit(proj, wanted, { title: values.title, description: values.description, status: values.status, scope: values.scope, aliases: values.alias });
    process.stdout.write("lane.updated " + lane.id + " — " + lane.title + " [" + lane.status + "]\n");
    return 0;
  }
  throw new Error("lane requires: list | create | edit");
}

// --- compaction -------------------------------------------------------

function cmdCompact(rest, home) {
  const { values } = parse(rest, { keep: { type: "string" } });
  const keep = values.keep ? Number(values.keep) : 3;
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error("--keep must be a safe integer of at least 1");
  const proj = resolveTarget(values, { registerMissing: true });
  let token;
  try { token = acquireLock(proj.lock); }
  catch (error) { throw new Error(`could not lock the Lane worklog for compaction: ${error.message}`); }
  try {
    // Read and decide under the same Lane lock appendRecord uses. A concurrent
    // start/intent/promote/end can therefore not be overwritten by a rewrite.
    const entries = readEntries(proj.worklog);
    if (entries.length === 0) { process.stdout.write("(nothing to compact)\n"); return 0; }
    const validation = validateRecords(entries);
    if (validation.errors.length) throw new Error(`refusing to compact an invalid worklog:\n${validation.errors.join("\n")}`);

    const startIdx = entries.map((e, i) => (e.record.type === "handoff.start" ? i : -1)).filter((i) => i >= 0);
    if (startIdx.length <= keep) { process.stdout.write(`only ${startIdx.length} session(s); keeping all\n`); return 0; }

    const promotionIndex = new Map();
    entries.forEach((entry, index) => {
      if (entry.record.type === "intent.promote") promotionIndex.set(entry.record.intentId, index);
    });
    let cutIdx = startIdx[startIdx.length - keep];
    // An open intent is owned by its originating session. Keep that whole
    // session whenever the intent is still open *or* its promotion survives in
    // the live suffix; never leave either an orphaned open or a promotion with
    // no prior open, even after later sessions.
    for (let i = 0; i < cutIdx; i += 1) {
      if (entries[i].record.type !== "intent.open") continue;
      const promotedAt = promotionIndex.get(entries[i].record.intentId);
      if (promotedAt !== undefined && promotedAt < cutIdx) continue;
      const ownerStart = [...startIdx].reverse().find((start) => start <= i);
      cutIdx = Math.min(cutIdx, ownerStart);
    }
    // Never archive a hard-cutoff session. A later start is valid recovery, but
    // the incomplete predecessor remains live for a human to reconcile.
    for (const start of startIdx) {
      if (start >= cutIdx) break;
      const next = startIdx.find((candidate) => candidate > start) ?? entries.length;
      if (!entries.slice(start + 1, next).some((entry) => entry.record.type === "handoff.end")) cutIdx = Math.min(cutIdx, start);
    }
    if (cutIdx === 0) { process.stdout.write("no closed session prefix can be safely archived\n"); return 0; }

    const archived = entries.slice(0, cutIdx);
    const live = entries.slice(cutIdx);
    const first = archived[0].record.seq;
    const last = archived.at(-1).record.seq;
    const archiveText = archived.map((e) => JSON.stringify(e.record)).join("\n") + "\n";
    const liveText = live.map((e) => JSON.stringify(e.record)).join("\n") + "\n";
    const archDir = path.join(path.dirname(proj.worklog), "archive");
    const archFile = path.join(archDir, `${first}-${last}.jsonl`);
    if (fs.existsSync(archFile)) {
      if (fs.readFileSync(archFile, "utf8") !== archiveText) throw new Error(`archive collision at ${archFile}; refusing to overwrite it`);
    } else {
      // Publish the archive first: if the next durable replacement fails, the
      // original live worklog remains intact and a retry is idempotent.
      writeFileAtomic(archFile, archiveText);
    }
    const rewritten = readEntriesText(liveText);
    const rewrittenValidation = validateRecords(rewritten);
    if (rewrittenValidation.errors.length) throw new Error(`compaction would produce an invalid live worklog:\n${rewrittenValidation.errors.join("\n")}`);
    writeFileAtomic(proj.worklog, liveText);
    process.stdout.write(`archived ${archived.length} record(s) (seq ${first}-${last}) → ${archFile}\nlive worklog: ${live.length} record(s)\n`);
    return 0;
  } finally {
    releaseLock(proj.lock, token);
  }
}

function readEntriesText(text) {
  // The source was parsed already; this narrow adapter keeps the replacement
  // validation on exactly the JSONL representation that will reach disk.
  return text.trim() === "" ? [] : text.trim().split("\n").map((line, index) => ({ record: JSON.parse(line), no: index + 1 }));
}

// --- misc -------------------------------------------------------------

function assertGate(v, allowUndefined) {
  if (v === undefined) { if (allowUndefined) return; throw new Error("--gate is required (pass | fail | not-run)"); }
  if (!["pass", "fail", "not-run"].includes(v)) throw new Error("--gate must be pass | fail | not-run");
}

function labelWorker(w) {
  return typeof w === "string" ? w : (w?.id ?? "?");
}
