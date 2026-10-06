import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repoFromRemote, type AgentLink, type PastSession } from "../shared/agentLinks.js";
import { workspaceOf } from "../shared/settings.js";
import { lastMessages } from "./indexer.js";
import { sendToTerm } from "./pty.js";
import { sessionPrActivity } from "./sessionPrs.js";
import { getSession, listSessions } from "./sessions.js";
import { getSettings } from "./settings.js";

const exec = promisify(execFile);

export type { AgentLink, PastSession } from "../shared/agentLinks.js";

// The agent sessions running in deck terminals, with what ties each one to a
// pull request: the branch its checkout is on, its origin repository and the
// PRs it opened. The matching itself is in shared/agentLinks.ts.

const GIT_TTL_MS = 10_000;
const checkouts = new Map<string, { expires: number; result: Promise<{ branch: string | null; repo: string | null }> }>();

const gitOut = (cwd: string, args: string[]) =>
  exec("git", args, { cwd, timeout: 5_000 }).then(({ stdout }) => stdout.trim(), () => "");

/** The branch and origin of a directory, cached briefly: agents switch
 *  branches, but not every few seconds. */
function checkout(cwd: string): Promise<{ branch: string | null; repo: string | null }> {
  const cached = checkouts.get(cwd);
  if (cached && cached.expires > Date.now()) return cached.result;
  const result = Promise.all([gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), gitOut(cwd, ["remote", "get-url", "origin"])])
    .then(([branch, remote]) => ({ branch: branch && branch !== "HEAD" ? branch : null, repo: remote ? repoFromRemote(remote) : null }));
  checkouts.set(cwd, { expires: Date.now() + GIT_TTL_MS, result });
  return result;
}

let inflight: Promise<AgentLink[]> | undefined;

/** Live sessions in deck terminals of the active workspace. Every page that
 *  shows agents asks after each burst of hooks, so concurrent asks share one look. */
export function listAgentLinks(): Promise<AgentLink[]> {
  inflight ??= collectLinks().finally(() => (inflight = undefined));
  return inflight;
}

async function collectLinks(): Promise<AgentLink[]> {
  const { activeWorkspace, workspaces } = getSettings();
  const live = listSessions(200).filter((s) => s.term_id && s.status !== "ended" && workspaceOf(s.workspace, workspaces) === activeWorkspace);
  return Promise.all(live.map(async (session) => {
    const [{ branch, repo }, prs] = await Promise.all([
      session.cwd ? checkout(session.cwd) : { branch: null, repo: null },
      sessionPrActivity(session.session_id).catch(() => ({ created: [], touched: [] })),
    ]);
    return {
      sessionId: session.session_id,
      termId: session.term_id!,
      agent: session.agent,
      status: session.status,
      title: session.title,
      cwd: session.cwd,
      issueKey: session.issue_key,
      branch,
      repo,
      createdPrs: prs.created,
      touchedPrs: resolve(prs.touched, repo),
      reviewNote: session.review_note,
      updatedAt: session.updated_at,
    };
  }));
}

/** "?#n" stands for a PR in the checkout's own repository. */
const resolve = (keys: string[], repo: string | null) =>
  [...new Set(keys.flatMap((key) => (key.startsWith("?#") ? (repo ? [`${repo}${key.slice(1)}`] : []) : [key])))];

const PAST_DAYS = 7;
const PAST_LIMIT = 60;

/** For each PR, the most recent finished session in this workspace that
 *  opened it or worked on it, to resume when no live agent is on it. Only
 *  the last week counts; finished transcripts no longer grow, so each is
 *  read once. */
export async function pastSessionsFor(prKeys: string[]): Promise<Record<string, PastSession>> {
  const wanted = new Set(prKeys);
  const { activeWorkspace, workspaces } = getSettings();
  const since = Date.now() - PAST_DAYS * 86_400_000;
  const ended = listSessions(400)
    .filter((s) => s.status === "ended" && s.updated_at > since && !s.session_id.startsWith("pending:") && workspaceOf(s.workspace, workspaces) === activeWorkspace)
    .slice(0, PAST_LIMIT);
  const found: Record<string, PastSession> = {};
  for (const session of ended) {
    const prs = await sessionPrActivity(session.session_id).catch(() => ({ created: [], touched: [] }));
    const repo = prs.touched.some((key) => key.startsWith("?#")) && session.cwd ? (await checkout(session.cwd)).repo : null;
    const hits: [string, PastSession["reason"]][] = [
      ...prs.created.map((key) => [key, "opened"] as [string, PastSession["reason"]]),
      ...resolve(prs.touched, repo).map((key) => [key, "touched"] as [string, PastSession["reason"]]),
    ];
    for (const [key, reason] of hits) {
      // Sessions come newest first, so the first hit per PR is the one to resume.
      if (!wanted.has(key) || found[key]) continue;
      found[key] = { sessionId: session.session_id, agent: session.agent, cwd: session.cwd, title: session.title, updatedAt: session.updated_at, reason };
    }
  }
  return found;
}

/** The agent's latest reply, one line, from the conversation index; it lags
 *  the live terminal by a moment, which is fine for a glance. */
export function lastWords(sessionId: string): string | null {
  const said = lastMessages(sessionId, 8).reverse().find((message) => message.role === "assistant" && message.text.trim());
  return said ? said.text.replace(/\s+/g, " ").trim().slice(0, 240) : null;
}

/** Types a message into the session's terminal and submits it. */
export function sendToAgent(sessionId: string, text: string): { ok: true } | { ok: false; error: string } {
  const session = getSession(sessionId);
  if (!session?.term_id || session.status === "ended") return { ok: false, error: "That agent is no longer running in a deck terminal." };
  if (!text.trim()) return { ok: false, error: "Nothing to send." };
  sendToTerm(session.term_id, text.trim());
  return { ok: true };
}
