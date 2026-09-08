// Human-readable rendering for `ahp status`, `ahp pickup`, `ahp log`.

function workerLabel(worker) {
  if (!worker) return "?";
  if (typeof worker === "string") return worker;
  const bits = [worker.id, worker.model && worker.model !== worker.id ? `(${worker.model})` : null].filter(Boolean);
  return bits.join(" ");
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function renderStatus({ project, git: g, analysis }) {
  const L = [];
  L.push(`project   ${project.name}  [${project.id}]`);
  if (project.lane) L.push(`lane      ${project.lane.id}  (${project.lane.title})`);
  if (project.remote) L.push(`remote    ${project.remote}`);
  L.push(`root      ${g.root ?? "?"}${g.branch ? `  (${g.branch})` : ""}`);
  L.push(`head      ${g.short ?? "?"}   tree ${g.clean === null ? "?" : g.clean ? "clean" : "DIRTY"}`);
  L.push("");
  if (analysis.count === 0) {
    L.push("worklog   empty — run `ahp start --plan \"…\"` to take the baton");
    return L.join("\n");
  }
  const s = analysis.lastStart;
  const lastRec = analysis.records[analysis.records.length - 1];
  const b = analysis.baton;
  if (!b) {
    L.push(`baton     never taken — ${analysis.count} record(s) but no handoff.start`);
    L.push("          run `ahp pickup` then `ahp start`");
  } else if (analysis.batonHeld) {
    L.push(`baton     HELD by ${workerLabel(analysis.batonWorker)}  (since ${ago(s.at)})`);
    L.push(`          session ${b.sessionId}  ·  plan: ${s.plan}`);
  } else {
    L.push(`baton     free — session ${b.sessionId} by ${workerLabel(lastRec?.worker ?? s?.worker)} ended ${lastRec ? ago(lastRec.at) : "?"}`);
    L.push("          run `ahp pickup` then `ahp start`");
  }
  L.push(`records   ${analysis.count}   last seq ${analysis.lastSeq}`);
  if (analysis.openIntents.length) {
    L.push("");
    L.push(`open intents (${analysis.openIntents.length}) — likely uncommitted work:`);
    for (const it of analysis.openIntents) L.push(`  · ${it.intentId}  ${it.title}`);
  }
  const v = analysis.validation;
  if (v.errors.length) {
    L.push("");
    L.push(`worklog has ${v.errors.length} error(s):`);
    for (const e of v.errors) L.push(`  ! ${e}`);
  }
  return L.join("\n");
}

export function renderPickup({ project, git: g, analysis, sinceCommits, reconcile, selfHistory, full = false }) {
  const lines = [];
  const laneLabel = project.lane ? " · Lane " + project.lane.id + " (" + project.lane.title + ")" : "";
  lines.push("# AHP pickup — " + project.name + " [" + project.id + "]" + laneLabel);
  lines.push("");
  if (analysis.count === 0) {
    lines.push("Worklog is empty. This is a fresh start.");
    lines.push("Next: `ahp start --plan \"…\" --gate pass|fail|not-run`");
    return lines.join("\n");
  }
  if (selfHistory) {
    lines.push("You (" + selfHistory.meId + ") last held the baton for this Lane at seq " + selfHistory.seq + ", " + ago(selfHistory.at) + ".");
    lines.push(selfHistory.handoffsSince + " handoff" + (selfHistory.handoffsSince === 1 ? "" : "s") + " since; continue from the Lane state below, not from memory.");
    lines.push("");
  }
  const start = analysis.lastStart;
  if (!start) {
    lines.push("No handoff.start yet — " + analysis.count + " record(s) written without one.");
    lines.push("Inspect them with `ahp log`, then start the Lane.");
    return lines.join("\n");
  }

  lines.push("Last handoff: " + workerLabel(start.worker) + " · " + ago(start.at) + " · base " + String(start.base?.commit ?? "?").slice(0, 12) + " · gate " + (start.base?.gate ?? "?"));
  lines.push("  plan: " + String(start.plan ?? "").slice(0, full ? 1000 : 240));
  if (analysis.batonHeld) {
    lines.push("  ⚠ no handoff.end — treat this as a cutoff");
  } else {
    const end = [...analysis.records].reverse().find((record) => record.type === "handoff.end");
    if (end) lines.push("  session ended cleanly (" + end.reason + ") at " + String(end.end?.commit ?? "?").slice(0, 12) + " · gate " + (end.end?.gate ?? "?"));
  }
  lines.push("");

  const linksFor = (commit) => [...new Set([
    ...(reconcile.commitToIntent.get(commit.short) ?? []),
    ...(reconcile.commitToIntentLong.get(commit.short.slice(0, 7)) ?? [])
  ])];
  const unmatched = sinceCommits.filter((commit) => linksFor(commit).length === 0);
  const matched = sinceCommits.filter((commit) => linksFor(commit).length > 0);
  lines.push("Commits since base → HEAD: " + sinceCommits.length + " commit(s) · " + matched.length + " promoted · " + unmatched.length + " unmatched");

  let visibleCommits;
  if (full) {
    visibleCommits = sinceCommits;
  } else {
    const attention = unmatched.slice(0, 8);
    const room = Math.max(0, 10 - attention.length);
    const recent = matched.slice(-room);
    const seen = new Set(attention.map((commit) => commit.short));
    visibleCommits = [...attention, ...recent.filter((commit) => !seen.has(commit.short))];
  }
  for (const commit of visibleCommits) {
    const links = linksFor(commit);
    lines.push("  " + commit.short + "  " + commit.subject + (links.length ? "   ✓ " + links.join(", ") : "   ⚠ unmatched"));
  }
  const omittedCommits = sinceCommits.length - visibleCommits.length;
  if (omittedCommits > 0) lines.push("  … " + omittedCommits + " commit(s) omitted from the compact view; run `ahp pickup --full` if needed.");
  if (!full && unmatched.length > 8) {
    lines.push("  ⚠ " + (unmatched.length - 8) + " unmatched commit(s) omitted; run `ahp pickup --full` before starting.");
  }
  lines.push("");

  if (reconcile.unreadLanes.length) {
    lines.push("  ⚠ cross-Lane commit associations unavailable from: " + reconcile.unreadLanes.join(", "));
    lines.push("");
  }

  if (full && reconcile.danglingPromotes.length) {

    lines.push("Historical promotions not reachable from HEAD:");
    for (const promotion of reconcile.danglingPromotes) {
      lines.push("  ⚠ " + promotion.intentId + " → " + promotion.commits.join(", "));
    }
    lines.push("");
  }

  const visibleIntents = full ? analysis.openIntents : analysis.openIntents.slice(0, 5);
  lines.push("Open intents: " + analysis.openIntents.length);
  for (const intent of visibleIntents) {
    lines.push("  ○ " + intent.intentId + " — " + intent.title);
    lines.push("    " + String(intent.intended ?? "").slice(0, full ? 1000 : 200));
  }
  if (analysis.openIntents.length > visibleIntents.length) {
    lines.push("  … " + (analysis.openIntents.length - visibleIntents.length) + " omitted; run `ahp pickup --full`.");
  }
  lines.push("");

  lines.push("Working tree: " + (g.clean === null ? "?" : g.clean ? "clean" : "DIRTY (" + g.dirty.length + " path(s))"));
  const visibleDirty = full ? g.dirty : g.dirty.slice(0, 10);
  for (const dirty of visibleDirty) lines.push("  " + dirty);
  if (g.dirty.length > visibleDirty.length) lines.push("  … " + (g.dirty.length - visibleDirty.length) + " path(s) omitted.");
  lines.push("");
  lines.push("Next: reconcile the items above, run the project gate, then `ahp start --plan \"…\" --gate …`.");
  return lines.join("\n");
}

export function renderLog(records) {
  const L = [];
  let session = 0;
  for (const r of records) {
    if (r.type === "handoff.start") {
      session += 1;
      L.push("");
      L.push(`── session ${session}: ${r.sessionId ?? workerLabel(r.worker)} · ${r.at} ──`);
      L.push(`   from ${r.base?.commit?.slice(0, 12) ?? "?"} (gate ${r.base?.gate ?? "?"})  ·  ${r.plan}`);
    } else if (r.type === "intent.open") {
      L.push(`   ○ ${r.intentId}  ${r.title}`);
    } else if (r.type === "intent.promote") {
      L.push(`   ● ${r.intentId}  → ${(r.commits ?? []).join(", ") || "(wip)"}  [gate ${r.gate}]`);
      L.push(`       ${r.actual}`);
      for (const m of r.landmines ?? []) L.push(`       ⚠ ${m}`);
      if (r.next) L.push(`       → next: ${r.next}`);
    } else if (r.type === "handoff.end") {
      L.push(`   ✕ end (${r.reason}) at ${r.end?.commit?.slice(0, 12) ?? "?"} gate ${r.end?.gate ?? "?"}`);
      L.push(`       ${r.summary}`);
      for (const f of r.findings ?? []) L.push(`       ! ${f}`);
    }
  }
  return L.join("\n").trimStart();
}

export { workerLabel };
