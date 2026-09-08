// Store location resolution.
//
// Precedence: $AHP_HOME  >  $XDG_DATA_HOME/agent-handoff  >  ~/.local/share/agent-handoff
//
// Layout under the store:
//   projects.json                              Project registry
//   projects/<id>/lanes.json                   editable Lane registry
//   projects/<id>/lanes/<lane>/worklog.jsonl   append-only Lane stream
//   projects/<id>/lanes/<lane>/archive/*       compacted Lane spans
//   projects/<id>/worklog.jsonl                legacy stream (Lane `main`)

import os from "node:os";
import path from "node:path";

export function storeHome(env = process.env) {
  if (env.AHP_HOME && env.AHP_HOME.trim() !== "") return path.resolve(env.AHP_HOME);
  const xdg = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() !== "" ? env.XDG_DATA_HOME : path.join(os.homedir(), ".local", "share");
  return path.join(path.resolve(xdg), "agent-handoff");
}

export function registryPath(home = storeHome()) {
  return path.join(home, "projects.json");
}

export function projectDir(id, home = storeHome()) {
  return path.join(home, "projects", id);
}

export function worklogPath(id, home = storeHome()) {
  return path.join(projectDir(id, home), "worklog.jsonl");
}

export function archiveDir(id, home = storeHome()) {
  return path.join(projectDir(id, home), "archive");
}

export function lockPath(id, home = storeHome()) {
  return path.join(projectDir(id, home), ".lock");
}
