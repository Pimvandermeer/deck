import { prKey } from "./prs.js";

// Per ticket, what happened on its pull requests and whether any of it is
// new to the user. Commits are compared by oid, never by date: a rebase or
// a push of older commits moves no committedDate forward.

export interface ActivityPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  /** OPEN, MERGED or CLOSED. */
  state: string;
  isDraft: boolean;
  mergedAt: string | null;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  headOid: string;
  reviewDecision: string | null;
  mergeable: string;
  /** Status check rollup of the head commit: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED or NONE. */
  checks: string;
  lastCommit: { at: string; author: string; oid: string } | null;
  /** Latest submitted review by someone other than the PR author, bots left out. */
  lastReview: { at: string; author: string; state: string; onHead: boolean } | null;
  /** Latest review or comment by anyone but the viewer, bots left out; replies in threads count as reviews. */
  lastTalk: { at: string; author: string; kind: "review" | "comment"; state?: string } | null;
  unresolvedThreads: number;
  /** Reviews still owed: user logins, or "@team" for a team request. Absent in caches from older versions. */
  requestedReviewers?: string[];
  /** Everyone but the author who has submitted a review, latest first. */
  reviewers?: string[];
  /** The commit the viewer's latest review was on; null when they have not reviewed. */
  viewerReviewOid?: string | null;
}

export interface BoardActivity {
  viewer: string;
  /** Keyed by prKey. Holds the board's PRs and every PR in the review inbox. */
  prs: Record<string, ActivityPr>;
  /** Ticket key → prKeys of its PRs that are not closed unmerged. */
  tickets: Record<string, string[]>;
  at: number;
}

export interface PrMark {
  head: string;
  state: string;
  checks: string;
  talkAt: string;
  at: string;
}

export interface TicketMark {
  status: string;
  at: string;
}

/** What the user last saw, per ticket and per PR. Created with everything
 *  marked, so only what happens afterwards reads as new. */
export interface ActivitySeen {
  tickets: Record<string, TicketMark>;
  prs: Record<string, PrMark>;
}

export interface SeenTarget {
  tickets?: string[];
  prs?: string[];
}

/** The subset of a board issue this module reads; BoardIssue fits it. */
export interface ActivityIssue {
  key: string;
  statusId: string;
  statusName: string;
  assigneeId: string | null;
  updated: string;
}

export function markPr(pr: ActivityPr, at: string): PrMark {
  return { head: pr.headOid, state: pr.state, checks: pr.checks, talkAt: pr.lastTalk?.at ?? "", at };
}

const settledChecks: Record<string, string> = { SUCCESS: "CI passed", FAILURE: "CI failing", ERROR: "CI failing" };

/** Why a PR reads as new since the user last looked; empty when it does not.
 *  The user's own commits and comments never count. A pending CI run is not
 *  news, only the result it settles on. */
export function prChanges(pr: ActivityPr, mark: PrMark | undefined, viewer: string): string[] {
  if (!mark) return [`new PR #${pr.number}`];
  const changes: string[] = [];
  if (pr.state !== mark.state) changes.push(pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "reopened");
  if (pr.headOid !== mark.head && pr.lastCommit?.author !== viewer)
    changes.push(pr.lastCommit?.author ? `new commits by ${pr.lastCommit.author}` : "new commits");
  if (pr.checks !== mark.checks && settledChecks[pr.checks]) changes.push(settledChecks[pr.checks]);
  if (pr.lastTalk && pr.lastTalk.at > mark.talkAt) {
    const { author, kind, state } = pr.lastTalk;
    changes.push(kind === "comment" ? `comment by ${author}` : `${reviewVerb(state)} by ${author}`);
  }
  return changes;
}

function reviewVerb(state: string | undefined): string {
  if (state === "APPROVED") return "approved";
  if (state === "CHANGES_REQUESTED") return "changes requested";
  return "review";
}

export type Ball = "author" | "review" | "merge" | "done";

/** Whose move it is. A review on the head commit hands it to the author
 *  (to merge when it approved); commits the last review did not see hand it
 *  back to the reviewers. */
export function ballFor(pr: ActivityPr): Ball {
  if (pr.state !== "OPEN") return "done";
  if (pr.isDraft) return "author";
  if (!pr.lastReview?.onHead) return "review";
  return pr.lastReview.state === "APPROVED" ? "merge" : "author";
}

/** Where the ball is from the user's side: with them, with someone they are
 *  waiting on (their PR, or a PR they reviewed), with others entirely, or
 *  nowhere because the PR is closed. */
export type Stance = "you" | "them" | "others" | "done";

export type BallAction = "review" | "re-review" | "address" | "merge" | "fix CI" | "resolve conflicts" | "finish draft" | "answer agent" | "move ticket";

export interface BallState {
  stance: Stance;
  /** Who holds it: GitHub logins, "@team", or empty when anyone may pick it up. */
  who: string[];
  action: BallAction;
  /** When it landed there, as near as the PR tells. */
  since: string;
}

const failing = (pr: ActivityPr) => pr.checks === "FAILURE" || pr.checks === "ERROR";
const later = (a: string | undefined, b: string | undefined) => ((a ?? "") > (b ?? "") ? a ?? "" : b ?? "");

/** The ball on one PR, read from the viewer's side. `requested` is whether
 *  GitHub lists the viewer as asked to review, which also covers team requests. */
export function ballFrom(pr: ActivityPr, viewer: string, requested = false): BallState {
  const reviewSince = later(pr.lastCommit?.at, pr.lastReview?.at) || pr.createdAt;
  const authorSince = pr.lastReview?.at ?? pr.updatedAt;
  if (pr.state !== "OPEN") return { stance: "done", who: [], action: "merge", since: pr.mergedAt ?? pr.updatedAt };
  const ball = ballFor(pr);
  const owed = (pr.requestedReviewers ?? []).filter((login) => login !== viewer);
  const askedMe = requested || (pr.requestedReviewers ?? []).includes(viewer);
  // Reviewers to chase: the ones still asked, else the ones who reviewed before.
  const reviewersOwed = owed.length ? owed : (pr.reviewers ?? []).filter((login) => login !== viewer).slice(0, 2);
  const reviewAction: BallAction = pr.lastReview ? "re-review" : "review";

  if (pr.author === viewer) {
    if (pr.isDraft) return { stance: "you", who: [viewer], action: "finish draft", since: pr.lastCommit?.at ?? pr.createdAt };
    if (failing(pr)) return { stance: "you", who: [viewer], action: "fix CI", since: pr.lastCommit?.at ?? pr.updatedAt };
    if (pr.mergeable === "CONFLICTING") return { stance: "you", who: [viewer], action: "resolve conflicts", since: pr.updatedAt };
    if (ball === "merge") return { stance: "you", who: [viewer], action: "merge", since: authorSince };
    if (ball === "author") return { stance: "you", who: [viewer], action: "address", since: authorSince };
    return { stance: "them", who: reviewersOwed, action: reviewAction, since: reviewSince };
  }

  const reviewedByMe = Boolean(pr.viewerReviewOid);
  if (pr.isDraft) return { stance: reviewedByMe ? "them" : "others", who: [pr.author], action: "finish draft", since: pr.lastCommit?.at ?? pr.createdAt };
  if (ball === "review" && (askedMe || (reviewedByMe && pr.viewerReviewOid !== pr.headOid)))
    return { stance: "you", who: [viewer], action: reviewedByMe ? "re-review" : "review", since: reviewSince };
  const involved = askedMe || reviewedByMe;
  if (failing(pr)) return { stance: involved ? "them" : "others", who: [pr.author], action: "fix CI", since: pr.lastCommit?.at ?? pr.updatedAt };
  if (ball === "review") return { stance: "others", who: reviewersOwed, action: reviewAction, since: reviewSince };
  return { stance: involved ? "them" : "others", who: [pr.author], action: ball === "merge" ? "merge" : "address", since: authorSince };
}

const actionWords: Record<BallAction, string> = {
  review: "review", "re-review": "re-review", address: "address review", merge: "merge",
  "fix CI": "fix CI", "resolve conflicts": "fix conflicts", "finish draft": "finish draft", "answer agent": "answer agent",
  "move ticket": "move ticket",
};

/** The ball as a short phrase: "Your review", "Waiting on deldering to merge", "Open for review". */
export function ballText(state: BallState): string {
  const names = state.who.join(", ");
  if (state.stance === "done") return "Done";
  if (state.stance === "you") {
    if (state.action === "merge") return "Ready to merge";
    if (state.action === "review" || state.action === "re-review") return `Your ${state.action}`;
    if (state.action === "finish draft") return "Your draft";
    return `Your move: ${actionWords[state.action]}`;
  }
  if (!names) return state.stance === "them" ? `Waiting on a ${state.action}` : state.action === "review" ? "Open for review" : `Waiting on a ${state.action}`;
  return state.stance === "them" ? `Waiting on ${names} to ${actionWords[state.action]}` : `${names} to ${actionWords[state.action]}`;
}

const stanceRank: Record<Stance, number> = { you: 0, them: 1, others: 2, done: 3 };

/** A ticket's ball: the most pressing of its PRs', with an agent waiting on the user above all. */
export function ticketBall(states: BallState[], agentWaiting?: { since: string }): BallState | undefined {
  if (agentWaiting) return { stance: "you", who: [], action: "answer agent", since: agentWaiting.since };
  return [...states].sort((a, b) => stanceRank[a.stance] - stanceRank[b.stance] || a.since.localeCompare(b.since))[0];
}

export interface BallSummary {
  you: number;
  them: number;
  others: number;
  /** For the user: how many of each thing to do. */
  yourActions: [BallAction, number][];
  /** Who the user is waiting on, most-waited-on first. */
  waitingOn: [string, number][];
  /** What the PRs between others are waiting for. */
  othersActions: [BallAction, number][];
}

/** Counts per stance, over tickets (one ball each), with what is behind the numbers. */
export function summarizeBalls(balls: (BallState | undefined)[]): BallSummary {
  const count = <K extends string>(keys: K[]) => {
    const tally = new Map<K, number>();
    for (const key of keys) tally.set(key, (tally.get(key) ?? 0) + 1);
    return [...tally].sort((a, b) => b[1] - a[1]);
  };
  const known = balls.filter((ball): ball is BallState => Boolean(ball));
  const of = (stance: Stance) => known.filter((ball) => ball.stance === stance);
  return {
    you: of("you").length,
    them: of("them").length,
    others: of("others").length,
    yourActions: count(of("you").map((ball) => ball.action)),
    waitingOn: count(of("them").flatMap((ball) => (ball.who.length ? ball.who : ["reviewers"]))),
    othersActions: count(of("others").map((ball) => ball.action)),
  };
}

/** The latest thing someone other than the user did on the PR. */
export function prLastActivity(pr: ActivityPr, viewer: string): string {
  const moments = [pr.lastTalk?.at, pr.mergedAt, pr.lastCommit?.author !== viewer ? pr.lastCommit?.at : undefined, pr.author !== viewer ? pr.createdAt : undefined];
  return moments.reduce<string>((latest, at) => (at && at > latest ? at : latest), "");
}

/** The PR the given one is stacked on, when its base is another PR's branch. */
export function stackedOn(pr: ActivityPr, all: ActivityPr[]): ActivityPr | undefined {
  return all.find((other) => other.repo === pr.repo && other.number !== pr.number && other.state === "OPEN" && other.headRefName === pr.baseRefName);
}

const DONE = /\b(done|closed|resolved|released|cancel+ed)\b/i;
const REVIEWED = /\b(reviewed|approved)\b/i;

export interface BoardRules {
  /** Columns the board treats as review. */
  reviewColumns: string[];
  /** Column merged work moves to, when set. */
  doneColumn?: string;
}

/** Status names are matched loosely, since every tracker names its columns its own way. */
export function isDone(issue: ActivityIssue, column: string, rules: BoardRules): boolean {
  return DONE.test(issue.statusName) || DONE.test(column) || (!!rules.doneColumn && column === rules.doneColumn);
}

/** Where the ticket and its PRs tell different stories. */
export function mismatchFlags(issue: ActivityIssue, column: string, prs: ActivityPr[], rules: BoardRules): string[] {
  const done = isDone(issue, column, rules);
  const inReview = !done && (rules.reviewColumns.includes(column) || /review/i.test(issue.statusName));
  const open = prs.filter((pr) => pr.state === "OPEN");
  const merged = prs.filter((pr) => pr.state === "MERGED");
  const flags: string[] = [];
  if (merged.length > 0 && open.length === 0 && !done) flags.push(`merged, ticket still ${issue.statusName}`);
  if (done && open.length > 0) flags.push("ticket done, PR still open");
  if (inReview && open.length + merged.length === 0) flags.push("in review without a PR");
  if (inReview && open.length > 0 && open.every((pr) => pr.isDraft)) flags.push("in review, PR is a draft");
  if (REVIEWED.test(issue.statusName) && open.some((pr) => pr.reviewDecision === "CHANGES_REQUESTED")) flags.push("reviewed in the tracker, changes requested on GitHub");
  return flags;
}

export interface ActivityRow<I extends ActivityIssue> {
  issue: I;
  column: string;
  prs: ActivityPr[];
  /** Why the row reads as new; empty once the user has seen it. */
  changes: string[];
  flags: string[];
  lastActivity: string;
  done: boolean;
}

// Jira writes "+0200" offsets and GitHub "Z"; only one shape compares as text.
const toIso = (at: string): string => {
  const time = Date.parse(at);
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
};

/** Ticket rows, new ones first, then most recent activity first. Rows wait
 *  for both the PR activity and the seen marks, so nothing flashes as new. */
export function activityRows<I extends ActivityIssue>(
  issues: I[],
  columns: { name: string; statusIds: string[] }[],
  activity: BoardActivity,
  seen: ActivitySeen,
  rules: BoardRules,
): ActivityRow<I>[] {
  const rows = issues.map((issue) => {
    const prs = (activity.tickets[issue.key] ?? [])
      .map((key) => activity.prs[key])
      .filter((pr): pr is ActivityPr => Boolean(pr))
      .sort((a, b) => b.number - a.number);
    const column = columns.find((c) => c.statusIds.includes(issue.statusId))?.name ?? issue.statusName;
    const mark = seen.tickets[issue.key];
    const changes = [
      ...(!mark ? ["new on the board"] : mark.status !== issue.statusName ? [`${mark.status} → ${issue.statusName}`] : []),
      ...prs.flatMap((pr) => prChanges(pr, seen.prs[prKey(pr)], activity.viewer).map((change) => (prs.length > 1 ? `#${pr.number} ${change}` : change))),
    ];
    const lastActivity = prs.reduce((latest, pr) => {
      const at = toIso(prLastActivity(pr, activity.viewer));
      return at > latest ? at : latest;
    }, toIso(issue.updated));
    return { issue, column, prs, changes, flags: mismatchFlags(issue, column, prs, rules), lastActivity, done: isDone(issue, column, rules) };
  });
  return rows.sort((a, b) => Number(b.changes.length > 0) - Number(a.changes.length > 0) || b.lastActivity.localeCompare(a.lastActivity));
}
