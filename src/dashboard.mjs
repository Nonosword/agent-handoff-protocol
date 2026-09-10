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

function timestamp(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "?";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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
  // File mtime changes during maintenance/copying and is not a handoff event.
  // The final record's protocol timestamp remains meaningful without polling.
  return { ...lane, analysis, readError, updated: analysis?.records.at(-1)?.at ?? null };
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
      error: row.laneError,
      lanes: row.lanes.map((lane) => ({
        id: lane.id,
        title: lane.title,
        description: lane.description,
        scope: lane.scope,
        aliases: lane.aliases,
        status: lane.status,
        verificationDisposition: lane.verificationDisposition ?? null,
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

function laneFailsStrictVerification(lane) {
  return !!(lane.readError || lane.analysis?.validation.errors.length || lane.analysis?.validation.warnings.length);
}

function render(rows, home, { footer = "", version = null } = {}) {
  const c = colors();
  const out = [""];
  const versionLabel = version ? ` v${version}` : "";
  out.push(`  ${c.bold(c.accent("Agent Handoff"))}${versionLabel} ${c.subtle("·")} ${rows.length} project${rows.length === 1 ? "" : "s"}   ${c.subtle(home)}`);
  out.push(`  ${c.rule("─".repeat(58))}`);

  const allLanes = rows.flatMap((row) => row.lanes);
  const activeLanes = allLanes.filter((lane) => lane.status === "active");
  const doneLanes = allLanes.filter((lane) => lane.status === "done");
  const legacyLanes = allLanes.filter((lane) => !["active", "done"].includes(lane.status));
  const held = activeLanes.filter((lane) => lane.analysis?.batonHeld).length;
  const lifecycleSummary = `${activeLanes.length} active (${held} held · ${activeLanes.length - held} free) · ${doneLanes.length} done`;
  out.push(`  ${c.subtle(`${lifecycleSummary}${legacyLanes.length ? ` · ${legacyLanes.length} legacy` : ""}`)}`);
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
      out.push(`    ${c.free("○")} ${c.subtle("no active or done Lane — first start can create one from its plan")}`);
    }

    const expandedLanes = row.lanes.filter((lane) => lane.status !== "done");
    const compactDone = row.lanes.filter((lane) => lane.status === "done");
    for (const lane of expandedLanes) {
      const a = lane.analysis;
      const laneName = lane.title;
      const legacyStatus = lane.status === "active" ? "" : ` ${c.warn(`[legacy ${lane.status}]`)}`;
      if (lane.readError) {
        anyError = true;
        out.push(`    ${c.err("✗")} ${c.bold(laneName)}${legacyStatus}  ${lane.readError}`);
        continue;
      }
      if (!a.count) {
        out.push(`    ${c.free("○")} ${c.bold(laneName)}${legacyStatus}  ${c.subtle("empty")}`);
        continue;
      }
      if (a.batonHeld) {
        out.push(`    ${c.held("●")} ${c.bold(laneName)}${legacyStatus}  held by ${c.bold(workerLabel(a.batonWorker))} since ${c.subtle(timestamp(a.lastStart.at))}`);
        if (a.lastStart.plan) out.push(`      ${c.subtle(a.lastStart.plan.slice(0, 92))}`);
      } else {
        out.push(`    ${c.free("○")} ${c.bold(laneName)}${legacyStatus}  ${c.subtle("baton free")}`);
      }
      const details = [`${a.count} records`, `seq ${a.lastSeq}`, `${a.promotes.length} promoted`];
      if (a.openIntents.length) details.push(`${a.openIntents.length} open`);
      if (lane.updated) details.push(timestamp(lane.updated));
      out.push(`      ${c.subtle(details.join(" · "))}`);
      if (a.validation.errors.length || a.validation.warnings.length) {
        anyError = true;
        out.push(`      ${c.warn(`⚠ verify: ${a.validation.errors.length} error(s), ${a.validation.warnings.length} warning(s)`)}`);
      }
    }
    if (compactDone.length) {
      const invalidDone = compactDone.filter(laneFailsStrictVerification);
      out.push(`    ${c.subtle(`✓ ${compactDone.length} done · ahp lane list to inspect`)}`);
      if (invalidDone.length) {
        anyError = true;
        out.push(`      ${c.warn(`⚠ ${invalidDone.length} done Lane${invalidDone.length === 1 ? "" : "s"} no longer pass strict verification`)}`);
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

export function storeWatcher(home, notify, onError = () => {}) {
  const watchers = [];
  let rearmTimer = null;
  let closed = false;
  const closeAll = () => {
    while (watchers.length) watchers.pop().close();
  };
  const scheduleRearm = () => {
    if (closed || rearmTimer !== null) return;
    // Filesystem backends often emit a burst for one atomic replacement.
    // Coalesce it without introducing a periodic fetch or repaint timer.
    rearmTimer = setTimeout(() => {
      rearmTimer = null;
      arm();
    }, 25);
  };
  const arm = () => {
    if (closed) return;
    closeAll();
    let root = home;
    while (!fs.existsSync(root) && path.dirname(root) !== root) root = path.dirname(root);
    // If the store has not been created yet, watch its nearest existing parent.
    // Once creation is observed, the next arm descends only into the store.
    const directories = root === home ? [home] : [root];
    for (let index = 0; index < directories.length; index += 1) {
      const dir = directories[index];
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) directories.push(path.join(dir, entry.name));
        }
      } catch (error) { onError(`cannot read ${dir}: ${error.message}`); continue; }
      try {
        const watcher = fs.watch(dir, () => {
          if (closed) return;
          notify();
          scheduleRearm();
        });
        // A directory can disappear while its watcher is active. Treat that
        // as a change and re-arm from the remaining tree instead of allowing
        // an unhandled EventEmitter error to terminate the dashboard.
        watcher.on("error", () => {
          if (closed) return;
          onError(`watch error at ${dir}`);
          notify();
          scheduleRearm();
        });
        watchers.push(watcher);
      } catch (error) { onError(`cannot watch ${dir}: ${error.message}`); }
    }
  };
  arm();
  return () => {
    closed = true;
    if (rearmTimer !== null) clearTimeout(rearmTimer);
    closeAll();
  };
}

function frameLines(frame) {
  const lines = frame.split("\n");
  // `render` terminates a frame with a newline. That terminator is not a
  // visible row, so excluding it keeps cursor coordinates stable.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function displayWidth(value) {
  const plain = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  let width = 0;
  for (const char of plain) {
    const code = char.codePointAt(0);
    if (code === 0 || (code >= 0x300 && code <= 0x36f)) continue;
    width += (code >= 0x1100 && (code <= 0x115f || code >= 0x2e80)) ? 2 : 1;
  }
  return width;
}

function truncateLine(value, width) {
  if (!Number.isFinite(width) || displayWidth(value) <= width) return value;
  const limit = Math.max(1, width - 1);
  let visible = 0;
  let out = "";
  for (let index = 0; index < value.length;) {
    const ansi = value.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
    if (ansi) { out += ansi[0]; index += ansi[0].length; continue; }
    const point = value.codePointAt(index);
    const char = String.fromCodePoint(point);
    const charWidth = point === 0 || (point >= 0x300 && point <= 0x36f) ? 0 : (point >= 0x1100 && (point <= 0x115f || point >= 0x2e80) ? 2 : 1);
    if (visible + charWidth > limit) break;
    out += char;
    visible += charWidth;
    index += char.length;
  }
  return `${out}…\x1b[0m`;
}

export function drawFrame(out, frame, previous = null) {
  const width = Number.isInteger(out.columns) ? Math.max(1, out.columns) : Infinity;
  const height = Number.isInteger(out.rows) ? Math.max(1, out.rows) : Infinity;
  let lines = frameLines(frame).map((line) => truncateLine(line, width));
  if (lines.length > height) lines = [...lines.slice(0, Math.max(0, height - 1)), `  … ${lines.length - height + 1} more row(s); enlarge terminal`];
  if (previous === null) {
    // The first paint owns a fresh alternate screen, so clearing it once is
    // both safe and useful. Subsequent paints must not clear the whole screen:
    // a one-second countdown should touch only its footer row.
    out.write(`\x1b[H\x1b[2J${lines.join("\n")}${lines.length ? "\n" : ""}`);
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
    const rows = snapshot(home);
    process.stdout.write(`${JSON.stringify(toJson(rows, version, home), null, 2)}\n`);
    return rows.some((row) => row.laneError || row.lanes.some(laneFailsStrictVerification)) ? 1 : 0;
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
    let updatedAt = timestamp(new Date().toISOString());
    let previousFrame = null;
    let watchError = null;
    closeWatcher = storeWatcher(home, () => signal.notify(), (message) => { watchError = message; });
    while (running) {
      const frame = render(rows, home, { version, footer: `${watchError ? `watch: ${watchError} · ` : ""}updated at ${updatedAt}` });
      previousFrame = drawFrame(out, frame.text, previousFrame);
      await signal.wait();
      if (!running) break;

      const next = fingerprint(home);
      if (next === key) continue;
      key = next;
      rows = snapshot(home);
      updatedAt = timestamp(new Date().toISOString());
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
