// `ahp dashboard` — cross-project overview, runnable from anywhere.

import fs from "node:fs";
import * as git from "./git.mjs";
import * as project from "./project.mjs";
import { worklogPath, storeHome } from "./paths.mjs";
import { readEntries, analyze } from "./worklog.mjs";

function colors() {
  const on = process.stdout.isTTY && !process.env.NO_COLOR;
  const w = (c) => (s) => (on ? `[${c}m${s}[0m` : String(s));
  return {
    on,
    accent: w("38;5;39"), ok: w("32"), warn: w("33"), err: w("31"),
    dim: w("90"), bold: w("1"),
    held: w("38;5;39"), free: w("90")
  };
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function workerLabel(w) {
  if (!w) return "?";
  if (typeof w === "string") return w;
  return w.id ?? "?";
}

function gather(p, home) {
  const worklog = worklogPath(p.id, home);
  let entries = [];
  let readError = null;
  try { entries = readEntries(worklog); }
  catch (e) { readError = e.message; }
  const a = analyze(entries);

  const root = (p.roots ?? []).find((r) => git.isGitRepo(r)) ?? (p.roots ?? [])[0] ?? null;
  const reachable = root ? git.isGitRepo(root) : false;
  const g = reachable
    ? { root, branch: git.branch(root), head: git.shortCommit(root), clean: git.isClean(root) }
    : { root, reachable: false };

  let drift = [];
  const base = a.lastStart?.base?.commit;
  if (reachable && base && base !== "unknown" && git.commitExists(root, base)) {
    const since = git.logRange(root, base, "HEAD");
    drift = since.filter((c) => !a.promotedCommits.some((pc) => pc === c.short || pc.startsWith(c.short) || c.short.startsWith(pc.slice(0, 7))));
  }

  let updated = null;
  try { updated = fs.statSync(worklog).mtime.toISOString(); } catch { /* absent */ }

  const lastAt = a.records.length ? a.records[a.records.length - 1].at : null;
  const staleBaton = a.batonHeld && lastAt && (Date.now() - Date.parse(lastAt)) > 3_600_000;

  return { p, a, g, reachable, readError, drift, updated, staleBaton };
}

function toJson(rows) {
  return rows.map(({ p, a, g, drift, staleBaton, readError }) => ({
    id: p.id,
    name: p.name,
    remote: p.remote,
    root: g.root,
    rootReachable: g.reachable !== false,
    branch: g.branch ?? null,
    head: g.head ?? null,
    treeClean: g.clean ?? null,
    baton: a.batonHeld ? { heldBy: workerLabel(a.batonWorker), since: a.lastStart?.at ?? null, plan: a.lastStart?.plan ?? null, stale: !!staleBaton } : null,
    records: a.count,
    lastSeq: a.lastSeq,
    promoted: a.promotes.length,
    openIntents: a.openIntents.map((i) => i.intentId),
    verify: readError ? { error: readError } : { errors: a.validation.errors, warnings: a.validation.warnings.length },
    driftCommits: drift.map((c) => ({ short: c.short, subject: c.subject }))
  }));
}

export function dashboard({ home = storeHome(), json = false } = {}) {
  const projects = project.list(home);
  const rows = projects.map((p) => gather(p, home));

  if (json) {
    process.stdout.write(`${JSON.stringify({ store: home, projects: toJson(rows) }, null, 2)}\n`);
    return 0;
  }

  const c = colors();
  const L = [];
  L.push("");
  L.push(`  ${c.accent(c.bold("Agent Handoff"))}  ${c.dim("·")}  ${rows.length} project${rows.length === 1 ? "" : "s"}   ${c.dim(home)}`);
  L.push(`  ${c.dim("─".repeat(58))}`);

  if (rows.length === 0) {
    L.push(`  ${c.dim("nothing registered yet — run `ahp status` inside a git repo")}`);
    process.stdout.write(L.join("\n") + "\n\n");
    return 0;
  }

  let anyError = false;
  const held = rows.filter((r) => r.a.batonHeld).length;
  L.push(`  ${c.dim(`${held} baton${held === 1 ? "" : "s"} held · ${rows.length - held} free`)}`);
  L.push("");

  for (const r of rows) {
    const { p, a, g } = r;
    L.push(`  ${c.bold(p.name)}  ${c.dim(`[${p.id}]`)}`);

    if (g.reachable === false) {
      L.push(`    ${c.warn("!")} ${c.dim(g.root ?? "path unknown")} ${c.dim("— not reachable from here")}`);
    } else {
      const tree = g.clean === null ? c.dim("?") : g.clean ? c.dim("clean") : c.warn("DIRTY");
      L.push(`    ${c.dim(g.root)}   ${c.dim(g.branch ?? "?")}  ${tree}  ${c.dim("@")} ${c.dim(g.head ?? "?")}`);
    }

    if (a.count === 0) {
      L.push(`    ${c.free("○")} ${c.dim("worklog empty — never used")}`);
    } else {
      if (a.batonHeld) {
        const s = r.staleBaton ? c.warn(` (stale — no activity ${ago(a.records.at(-1).at)})`) : "";
        L.push(`    ${c.held("●")} held by ${c.bold(workerLabel(a.batonWorker))}  ${c.dim(ago(a.lastStart.at))}${s}`);
        if (a.lastStart.plan) L.push(`      ${c.dim(a.lastStart.plan.slice(0, 92))}`);
      } else {
        L.push(`    ${c.free("○")} ${c.dim("baton free")}`);
      }
      L.push(`    ${c.dim(`${a.count} records · seq ${a.lastSeq} · ${a.promotes.length} promoted · ${a.openIntents.length} open${r.updated ? ` · ${ago(r.updated)}` : ""}`)}`);
      if (a.openIntents.length) {
        L.push(`      ${c.dim("open:")} ${a.openIntents.map((i) => i.intentId).join(", ")}`);
      }
    }

    if (r.readError) {
      anyError = true;
      L.push(`    ${c.err("✗ worklog:")} ${r.readError}`);
    } else if (a.validation.errors.length) {
      anyError = true;
      L.push(`    ${c.err(`✗ verify: ${a.validation.errors.length} error(s)`)}`);
      for (const e of a.validation.errors.slice(0, 3)) L.push(`      ${c.err(e)}`);
    }

    if (r.drift.length) {
      anyError = true;
      L.push(`    ${c.warn(`⚠ ${r.drift.length} commit(s) since the baton base with no intent.promote:`)}`);
      for (const d of r.drift.slice(0, 5)) L.push(`      ${c.warn(`${d.short} ${d.subject}`)}`);
    }

    L.push("");
  }

  process.stdout.write(L.join("\n") + "\n");
  return anyError ? 1 : 0;
}
