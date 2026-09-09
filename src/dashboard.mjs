// `ahp dashboard` — low-cost cross-project/Lane overview.

import fs from "node:fs";
import path from "node:path";
import * as git from "./git.mjs";
import * as project from "./project.mjs";
import * as lanes from "./lanes.mjs";
import { readEntries, analyze } from "./worklog.mjs";

export function colors({ on = process.stdout.isTTY && !process.env.NO_COLOR } = {}) {
  const w = (code) => (value) => (on ? `\x1b[${code}m${value}\x1b[0m` : String(value));
  return {
    on,
    accent: w("38;5;39"), warn: w("33"), err: w("31"),
    rule: w("90"), subtle: w("38;5;248"), bold: w("1"),
    held: w("38;5;39"), free: w("38;5;248")
  };
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function workerLabel(worker) {
  if (!worker) return "?";
  return typeof worker === "string" ? worker : worker.id ?? "?";
}

function fileMeta(file) {
  try {
    const stat = fs.statSync(file);
    return { stamp: `${stat.size}:${stat.mtimeMs}`, updated: stat.mtime.toISOString() };
  } catch {
    return { stamp: "-", updated: null };
  }
}

function projectDescriptor(entry) {
  const dir = path.join(entry.home, "projects", entry.id);
  return {
    ...entry,
    dir,
    worklog: path.join(dir, "worklog.jsonl"),
    lock: path.join(dir, ".lock")
  };
}

function projectRoot(entry) {
  return (entry.roots ?? []).find((root) => {
    try { return fs.statSync(root).isDirectory(); } catch { return false; }
  }) ?? null;
}

function gatherLane(lane) {
  let analysis = null;
  let readError = null;
  try { analysis = analyze(readEntries(lane.worklog)); }
  catch (error) { readError = error.message; }
  return { ...lane, analysis, readError, updated: fileMeta(lane.worklog).updated };
}

function gatherProject(entry) {
  const root = projectRoot(entry);
  const head = root ? git.headView(root) : { branch: null, short: null };
  let laneRows = [];
  let laneError = null;
  try { laneRows = lanes.list(projectDescriptor(entry), { includeArchived: false }).map(gatherLane); }
  catch (error) { laneError = error.message; }
  return { entry, root, head, lanes: laneRows, laneError };
}

function registeredProjects(home) {
  return project.list(home).map((entry) => ({ ...entry, home }));
}

function snapshot(home) {
  return registeredProjects(home).map(gatherProject);
}

function toJson(rows, version, home) {
  return {
    version,
    store: home,
    projects: rows.map((row) => ({
      id: row.entry.id,
      name: row.entry.name,
      remote: row.entry.remote ?? null,
      root: row.root,
      branch: row.head.branch,
      head: row.head.short,
      lanes: row.lanes.map((lane) => ({
        id: lane.id,
        title: lane.title,
        description: lane.description,
        scope: lane.scope,
        aliases: lane.aliases,
        status: lane.status,
        baton: lane.analysis?.baton ? { ...lane.analysis.baton, plan: lane.analysis.lastStart?.plan ?? null } : null,
        records: lane.analysis?.count ?? 0,
        lastSeq: lane.analysis?.lastSeq ?? 0,
        openIntents: lane.analysis?.openIntents.map((intent) => intent.intentId) ?? [],
        verify: lane.readError
          ? { error: lane.readError }
          : { errors: lane.analysis.validation.errors, warnings: lane.analysis.validation.warnings, notes: lane.analysis.validation.notes }
      }))
    }))
  };
}

function render(rows, home, { footer = "", version = null } = {}) {
  const c = colors();
  const out = [""];
  const versionLabel = version ? ` v${version}` : "";
  out.push(`  ${c.bold(c.accent("Agent Handoff"))}${versionLabel} ${c.subtle("·")} ${rows.length} project${rows.length === 1 ? "" : "s"}   ${c.subtle(home)}`);
  out.push(`  ${c.rule("─".repeat(58))}`);

  const allLanes = rows.flatMap((row) => row.lanes);
  const held = allLanes.filter((lane) => lane.analysis?.batonHeld).length;
  out.push(`  ${c.subtle(`${held} baton${held === 1 ? "" : "s"} held · ${allLanes.length - held} free · ${allLanes.length} Lane${allLanes.length === 1 ? "" : "s"}`)}`);
  out.push("");

  let anyError = false;
  for (const [index, row] of rows.entries()) {
    if (index > 0) {
      out.push(`  ${c.rule("─".repeat(58))}`);
      out.push("");
    }
    const gitLabel = row.root
      ? `${c.subtle(row.root)}   ${c.subtle(row.head.branch ?? "?")}  ${c.subtle("@")} ${c.subtle(row.head.short ?? "?")}`
      : c.subtle("path unavailable");
    out.push(`  ${c.bold(row.entry.name)}  ${c.subtle(`[${row.entry.id}]`)}`);
    out.push(`    ${gitLabel}`);

    if (row.laneError) {
      anyError = true;
      out.push(`    ${c.err("✗ lanes:")} ${row.laneError}`);
    } else if (row.lanes.length === 0) {
      out.push(`    ${c.free("○")} ${c.subtle("no Lane yet — first start creates one from its plan")}`);
    }

    for (const lane of row.lanes) {
      const a = lane.analysis;
      const laneName = `${lane.id} · ${lane.title}`;
      if (lane.readError) {
        anyError = true;
        out.push(`    ${c.err("✗")} ${c.bold(laneName)}  ${lane.readError}`);
        continue;
      }
      if (!a.count) {
        out.push(`    ${c.free("○")} ${c.bold(laneName)}  ${c.subtle("empty")}`);
        continue;
      }
      if (a.batonHeld) {
        out.push(`    ${c.held("●")} ${c.bold(laneName)}  held by ${c.bold(workerLabel(a.batonWorker))}  ${c.subtle(ago(a.lastStart.at))}`);
        if (a.lastStart.plan) out.push(`      ${c.subtle(a.lastStart.plan.slice(0, 92))}`);
      } else {
        out.push(`    ${c.free("○")} ${c.bold(laneName)}  ${c.subtle("baton free")}`);
      }
      out.push(`      ${c.subtle(`${a.count} records · seq ${a.lastSeq} · ${a.promotes.length} promoted · ${a.openIntents.length} open${lane.updated ? ` · ${ago(lane.updated)}` : ""}`)}`);
      if (a.validation.errors.length || a.validation.warnings.length) {
        anyError = true;
        out.push(`      ${c.warn(`⚠ verify: ${a.validation.errors.length} error(s), ${a.validation.warnings.length} warning(s)`)}`);
      }
    }
    out.push("");
  }

  if (!rows.length) out.push(`  ${c.subtle("nothing registered yet")}`);
  if (footer) out.push(`  ${c.subtle(footer)}`);
  return { text: out.join("\n") + "\n", anyError };
}

function fingerprint(home) {
  const rows = registeredProjects(home);
  return JSON.stringify(rows.map((entry) => {
    const descriptor = projectDescriptor(entry);
    let laneRows = [];
    try { laneRows = lanes.list(descriptor, { includeArchived: false }); } catch { /* render reports details */ }
    const root = projectRoot(entry);
    const head = root ? git.headView(root) : { branch: null, short: null };
    return [entry.id, entry.name, entry.roots, fileMeta(path.join(descriptor.dir, "lanes.json")).stamp, head.branch, head.short, ...laneRows.map((lane) => [lane.id, fileMeta(lane.worklog).stamp])];
  }));
}

function changeSignal() {
  let pending = false;
  let resolveWait = null;
  return {
    notify() {
      pending = true;
      if (resolveWait) {
        const resolve = resolveWait;
        resolveWait = null;
        resolve();
      }
    },
    wait() {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        resolveWait = () => { pending = false; resolve(); };
      });
    }
  };
}

export function storeWatcher(home, notify) {
  const watchers = [];
  let rearmQueued = false;
  const closeAll = () => {
    while (watchers.length) watchers.pop().close();
  };
  const arm = () => {
    closeAll();
    const directories = [home];
    for (let index = 0; index < directories.length; index += 1) {
      const dir = directories[index];
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) directories.push(path.join(dir, entry.name));
        }
      } catch { continue; }
      try {
        const watcher = fs.watch(dir, () => {
          notify();
          // A Lane directory may have appeared or been atomically replaced.
          // Re-arm from the tree after the current event turn; this remains
          // event-driven and does not poll the store.
          if (!rearmQueued) {
            rearmQueued = true;
            queueMicrotask(() => { rearmQueued = false; arm(); });
          }
        });
        // A directory can disappear while its watcher is active. Treat that
        // as a change and re-arm from the remaining tree instead of allowing
        // an unhandled EventEmitter error to terminate the dashboard.
        watcher.on("error", () => {
          notify();
          if (!rearmQueued) {
            rearmQueued = true;
            queueMicrotask(() => { rearmQueued = false; arm(); });
          }
        });
        watchers.push(watcher);
      } catch { /* unreadable or vanished directories are skipped */ }
    }
  };
  arm();
  return closeAll;
}

function frameLines(frame) {
  const lines = frame.split("\n");
  // `render` terminates a frame with a newline. That terminator is not a
  // visible row, so excluding it keeps cursor coordinates stable.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function drawFrame(out, frame, previous = null) {
  const lines = frameLines(frame);
  if (previous === null) {
    // The first paint owns a fresh alternate screen, so clearing it once is
    // both safe and useful. Subsequent paints must not clear the whole screen:
    // a one-second countdown should touch only its footer row.
    out.write(`\x1b[H\x1b[2J${frame}`);
    return lines;
  }

  const rowCount = Math.max(lines.length, previous.length);
  for (let index = 0; index < rowCount; index += 1) {
    if (lines[index] === previous[index]) continue;
    // Move directly to a changed row, erase that row completely, then draw its
    // replacement. Erasing also removes stale suffixes when a dynamic value
    // becomes shorter (for example, "updated HH:MM:SS" disappearing).
    out.write(`\x1b[${index + 1};1H\x1b[2K${lines[index] ?? ""}`);
  }
  return lines;
}

export async function dashboard({ home, version = null, json = false, watch = false } = {}) {
  if (json) {
    process.stdout.write(`${JSON.stringify(toJson(snapshot(home), version, home), null, 2)}\n`);
    return 0;
  }

  if (!watch || !process.stdout.isTTY) {
    const result = render(snapshot(home), home, {
      version,
      footer: watch ? "(--watch needs a TTY; showing one snapshot)" : ""
    });
    process.stdout.write(result.text);
    return result.anyError ? 1 : 0;
  }

  const out = process.stdout;
  const input = process.stdin;
  const signal = changeSignal();
  let running = true;
  const stop = () => { running = false; signal.notify(); };
  const onInput = (data) => {
    // Raw mode prevents touchpad arrow-key escape sequences from echoing into
    // the dashboard. Honour Ctrl-C ourselves because raw mode disables the
    // terminal driver's normal SIGINT conversion.
    if (Buffer.from(data).includes(3)) stop();
  };
  const rawInput = input.isTTY && typeof input.setRawMode === "function";
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (rawInput) {
    input.setRawMode(true);
    input.resume();
    input.on("data", onInput);
  }
  out.write("\x1b[?1049h\x1b[?25l");

  let closeWatcher = () => {};
  try {
    let key = fingerprint(home);
    let rows = snapshot(home);
    let updatedAt = new Date().toTimeString().slice(0, 8);
    let previousFrame = null;
    closeWatcher = storeWatcher(home, () => signal.notify());
    while (running) {
      const frame = render(rows, home, { version, footer: `updated at ${updatedAt}` });
      previousFrame = drawFrame(out, frame.text, previousFrame);
      await signal.wait();
      if (!running) break;

      const next = fingerprint(home);
      if (next === key) continue;
      key = next;
      rows = snapshot(home);
      updatedAt = new Date().toTimeString().slice(0, 8);
    }
  } finally {
    closeWatcher();
    out.write("\x1b[?25h\x1b[?1049l");
    if (rawInput) {
      input.removeListener("data", onInput);
      input.setRawMode(false);
      input.pause();
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return 0;
}
