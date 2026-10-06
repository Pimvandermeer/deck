import type { Agent } from "./agents.js";
import { prKey } from "./prs.js";

// Which running agent sessions belong to which pull request. An agent is on
// a PR when its checkout sits on the PR's branch, when it opened the PR, when
// it worked on the PR (a review, a look at its comments), or when it was
// started for the PR's ticket.

export type AgentStatus = "working" | "needs_input" | "needs_review" | "idle" | "ended";

export interface AgentLink {
  sessionId: string;
  termId: string;
  agent: Agent;
  status: AgentStatus;
  title: string | null;
  cwd: string;
  issueKey: string | null;
  /** Branch checked out in the session's directory; null when detached or not a repository. */
  branch: string | null;
  /** "owner/name" of the checkout's origin on GitHub. */
  repo: string | null;
  /** prKeys of the PRs the session's transcript shows it opening. */
  createdPrs: string[];
  /** prKeys of the PRs its prompts and commands pointed at, most recent first. */
  touchedPrs: string[];
  /** The agent's summary when it paused for review before pushing. */
  reviewNote: string | null;
  updatedAt: number;
}

export type LinkReason = "branch" | "opened" | "touched" | "ticket";

export interface LinkedAgent {
  link: AgentLink;
  reason: LinkReason;
}

const reasonRank: Record<LinkReason, number> = { branch: 0, opened: 1, touched: 2, ticket: 3 };

/** Waiting on the user: a question or permission prompt, or a pause for review. */
export const needsYou = (status: AgentStatus): boolean => status === "needs_input" || status === "needs_review";

const sameRepo = (a: string | null, b: string) => !a || a.toLowerCase() === b.toLowerCase();

function reasonFor(link: AgentLink, pr: { repo: string; number: number; headRefName: string }, ticketKey: string | undefined): LinkReason | undefined {
  if (link.branch && link.branch === pr.headRefName && sameRepo(link.repo, pr.repo)) return "branch";
  if (link.createdPrs.includes(prKey(pr))) return "opened";
  if ((link.touchedPrs ?? []).includes(prKey(pr))) return "touched";
  if (ticketKey && link.issueKey === ticketKey) return "ticket";
  return undefined;
}

/** One entry per session, keeping its strongest reason; the ones waiting on
 *  the user first, then the strongest link, then the most recently active. */
function rank(found: LinkedAgent[]): LinkedAgent[] {
  const best = new Map<string, LinkedAgent>();
  for (const entry of found) {
    const known = best.get(entry.link.sessionId);
    if (!known || reasonRank[entry.reason] < reasonRank[known.reason]) best.set(entry.link.sessionId, entry);
  }
  return [...best.values()].sort((a, b) =>
    Number(needsYou(b.link.status)) - Number(needsYou(a.link.status))
    || reasonRank[a.reason] - reasonRank[b.reason]
    || b.link.updatedAt - a.link.updatedAt);
}

export function agentsForPr(pr: { repo: string; number: number; headRefName: string }, ticketKey: string | undefined, links: AgentLink[]): LinkedAgent[] {
  return rank(links.flatMap((link) => {
    const reason = reasonFor(link, pr, ticketKey);
    return reason ? [{ link, reason }] : [];
  }));
}

/** Agents on any of the ticket's PRs, or started for the ticket itself. */
export function agentsForTicket(ticketKey: string, prs: { repo: string; number: number; headRefName: string }[], links: AgentLink[]): LinkedAgent[] {
  return rank([
    ...prs.flatMap((pr) => agentsForPr(pr, undefined, links)),
    ...links.filter((link) => link.issueKey === ticketKey).map((link) => ({ link, reason: "ticket" as const })),
  ]);
}

export function reasonLabel({ link, reason }: LinkedAgent): string {
  if (reason === "branch") return `on ${link.branch}`;
  if (reason === "opened") return "opened this PR";
  if (reason === "touched") return "worked on this PR";
  return `started for ${link.issueKey}`;
}

/** The agent to carry on with when the user picks the PR up. A review goes
 *  back to the session that was reviewing it, whatever branch it sits on;
 *  work on the PR itself goes to the one with the branch checked out. */
export function continueTarget(agents: LinkedAgent[], reviewing: boolean): LinkedAgent | undefined {
  const order: LinkReason[] = reviewing ? ["touched", "branch", "opened", "ticket"] : ["branch", "opened", "touched", "ticket"];
  return [...agents].sort((a, b) =>
    Number(needsYou(b.link.status)) - Number(needsYou(a.link.status))
    || order.indexOf(a.reason) - order.indexOf(b.reason)
    || b.link.updatedAt - a.link.updatedAt)[0];
}

/** A finished session that worked on a PR, which can be resumed in a new tab. */
export interface PastSession {
  sessionId: string;
  agent: Agent;
  cwd: string;
  title: string | null;
  updatedAt: number;
  reason: "opened" | "touched";
}

/** "owner/name" from an origin URL in any of git's spellings, or null when it is not GitHub. */
export function repoFromRemote(url: string): string | null {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}
