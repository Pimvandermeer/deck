import os from "node:os";
import path from "node:path";
import { getSettings } from "./settings.js";
import { listSessions, type AgentSession } from "./sessions.js";

// Decides what the agent panel's model may be told: which sessions, their
// transcripts, the issue board and the PR inbox. Every outbound path asks here.

// The repository of the active terminal tab, set by the renderer. Unset while
// that tab is not in a repository.
let currentProject: string | undefined;

export function setCurrentProject(root: string | undefined): void {
  currentProject = root;
}

function expand(directory: string): string {
  const trimmed = directory.trim();
  return trimmed.startsWith("~") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
}

/** Whether cwd is root or sits inside it, compared by path segment. */
function contains(root: string, cwd: string): boolean {
  const relative = path.relative(root, cwd);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Whether a session in this directory may be shared: always in "all", inside
 *  the current repository in "current", inside a listed one in "allowlist". */
export function canShareProject(cwd: string): boolean {
  const { mode, projects } = getSettings().agentSharing;
  if (mode === "all") return true;
  if (mode === "current") return Boolean(currentProject && contains(currentProject, cwd));
  return projects.map(expand).filter(Boolean).some((root) => contains(root, cwd));
}

/** Live sessions the agent may be told about. */
export function sharedSessions(): AgentSession[] {
  return listSessions().filter((session) => session.status !== "ended" && canShareProject(session.cwd));
}

/** How many live sessions are shared, out of how many exist. */
export function sharingSummary(): { shared: number; total: number } {
  const live = listSessions().filter((session) => session.status !== "ended");
  return { shared: live.filter((session) => canShareProject(session.cwd)).length, total: live.length };
}

/** Whether one session's transcript may be read. An unknown id is withheld. */
export function canShareSession(sessionId: string): boolean {
  if (getSettings().agentSharing.mode === "all") return true;
  const session = listSessions().find((s) => s.session_id === sessionId);
  return Boolean(session && canShareProject(session.cwd));
}

export function canShareTranscripts(): boolean {
  return getSettings().agentSharing.transcripts;
}

export function canShareBoard(): boolean {
  return getSettings().agentSharing.board;
}

export function canSharePullRequests(): boolean {
  return getSettings().agentSharing.pullRequests;
}

/** Stands in for data the settings withhold. */
export const WITHHELD = "The user has restricted what deck shares with you in Settings.";
