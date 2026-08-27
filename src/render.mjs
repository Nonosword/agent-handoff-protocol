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
  if (analysis.batonHeld) {
    L.push(`baton     HELD by ${workerLabel(analysis.batonWorker)}  (since ${ago(s.at)})`);
    L.push(`          plan: ${s.plan}`);
  } else {
    L.push(`baton     free — last session by ${workerLabel(lastRec?.worker ?? s?.worker)} ended ${lastRec ? ago(lastRec.at) : "?"}`);
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

export function renderPickup({ project, git: g, analysis, sinceCommits, reconcile, selfHistory }) {
  const L = [];
  L.push(`# AHP pickup — ${project.name} [${project.id}]`);
  L.push("");
  if (analysis.count === 0) {
    L.push("Worklog is empty. This is a fresh start.");
    L.push("Next: `ahp start --plan \"…\" --gate pass|fail|not-run`");
    return L.join("\n");
  }
  if (selfHistory) {
    L.push(`You (${selfHistory.meId}) last held the baton at seq ${selfHistory.seq}, ${ago(selfHistory.at)}.`);
    L.push(`${selfHistory.handoffsSince} handoff${selfHistory.handoffsSince === 1 ? "" : "s"} since. Your earlier plan may be stale — reconcile the changes below and continue forward, don't resume from memory.`);
    L.push("");
  }
  const s = analysis.lastStart;
  L.push(`Last handoff.start — ${workerLabel(s.worker)}, ${ago(s.at)}`);
  L.push(`  base commit : ${s.base?.commit ?? "?"}  (gate ${s.base?.gate ?? "?"})`);
  L.push(`  plan        : ${s.plan}`);
  if (analysis.batonHeld) {
    L.push(`  ⚠ that session wrote no handoff.end — treat as a cutoff; reconstruct from the commits and open intents below`);
  } else {
    const end = [...analysis.records].reverse().find((r) => r.type === "handoff.end");
    if (end) L.push(`  session ended cleanly (${end.reason}) at ${(end.end?.commit ?? "?").slice(0, 12)}, gate ${end.end?.gate ?? "?"}`);
  }
  L.push("");

  L.push(`Commits since ${(s.base?.commit ?? "?").slice(0, 12)} → HEAD (${g.short}): ${sinceCommits.length}`);
  for (const c of sinceCommits) {
    const known = reconcile.commitToIntent.get(c.short) ?? reconcile.commitToIntentLong.get(c.short);
    L.push(`  ${c.short}  ${c.subject}${known ? `   ✓ ${known}` : "   ⚠ no intent.promote names this"}`);
  }
  L.push("");

  if (reconcile.danglingPromotes.length) {
    L.push(`Promotions naming a commit not reachable from HEAD:`);
    for (const p of reconcile.danglingPromotes) L.push(`  ⚠ ${p.intentId} → ${p.commits.join(", ")}`);
    L.push("");
  }

  if (analysis.openIntents.length) {
    L.push(`Open intents (${analysis.openIntents.length}) — check the working tree for each:`);
    for (const it of analysis.openIntents) {
      L.push(`  · ${it.intentId}  ${it.title}`);
      L.push(`      intended: ${it.intended}`);
    }
    L.push("");
  }

  L.push(`Working tree: ${g.clean === null ? "?" : g.clean ? "clean" : `DIRTY (${g.dirty.length} path(s))`}`);
  for (const p of g.dirty.slice(0, 20)) L.push(`  ${p}`);
  L.push("");
  L.push("Then, once you have reconciled and run the gate yourself:");
  L.push("  ahp start --plan \"…\" --gate pass --evidence \"…\"");
  return L.join("\n");
}

export function renderLog(records) {
  const L = [];
  let session = 0;
  for (const r of records) {
    if (r.type === "handoff.start") {
      session += 1;
      L.push("");
      L.push(`── session ${session}: ${workerLabel(r.worker)} · ${r.at} ──`);
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
