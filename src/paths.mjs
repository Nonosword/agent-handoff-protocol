// Store location resolution.
//
// Precedence: $AHP_HOME  >  $XDG_DATA_HOME/agent-handoff  >  ~/.local/share/agent-handoff
//
// Layout under the store:
//   projects.json                 registry: id -> { name, remote, roots[], created }
//   projects/<id>/worklog.jsonl    the live worklog for one project
//   projects/<id>/archive/*.jsonl  compacted spans
//   projects/<id>/.lock            per-project write lock

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
