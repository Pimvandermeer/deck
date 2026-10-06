import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { markPr, type ActivityPr, type ActivitySeen, type BoardActivity, type SeenTarget } from "../shared/activity.js";
import { prKey } from "../shared/prs.js";
import { boardConfigured, getBoardCache } from "./board/board.js";
import { kvGet, kvSet } from "./db.js";
import { cachedPrsForIssue, prsForIssue } from "./issuePrs.js";
import { getPrInbox } from "./prInbox.js";
import { getSettings } from "./settings.js";

const exec = promisify(execFile);

export type { ActivitySeen, BoardActivity, SeenTarget } from "../shared/activity.js";

// Commit, review and CI state for every PR of every board card, plus the
// PRs in the review inbox, so the activity page and the reviews rail can say
// whose move it is and what is new. Unlike the inbox this keeps merged PRs
// and the user's own: a merged PR on an unmoved ticket is exactly the news.

interface Actor { __typename?: string; login: string }

interface ActivityNode {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  isDraft: boolean;
  state: string;
  mergedAt: string | null;
  updatedAt: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  reviewDecision: string | null;
  mergeable: string;
  author: Actor | null;
  repository: { nameWithOwner: string };
  commits: { nodes: { commit: { oid: string; committedDate: string; author: { name: string | null; user: { login: string } | null } | null; statusCheckRollup: { state: string } | null } }[] };
  reviews: { nodes: { state: string; submittedAt: string | null; author: Actor | null; commit: { oid: string } | null }[] };
  comments: { nodes: { createdAt: string; author: Actor | null }[] };
  reviewThreads: { nodes: { isResolved: boolean }[] };
  reviewRequests?: { nodes: { requestedReviewer: { __typename: string; login?: string; slug?: string } | null }[] };
}

const FIELDS = `number title url createdAt isDraft state mergedAt updatedAt headRefName headRefOid baseRefName reviewDecision mergeable
  author { __typename login } repository { nameWithOwner }
  commits(last: 1) { nodes { commit { oid committedDate author { name user { login } } statusCheckRollup { state } } } }
  reviews(last: 30) { nodes { state submittedAt author { __typename login } commit { oid } } }
  comments(last: 10) { nodes { createdAt author { __typename login } } }
  reviewThreads(first: 100) { nodes { isResolved } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } } } }`;

const isBot = (actor: Actor | null): boolean => !actor || actor.__typename === "Bot" || /\[bot\]$/.test(actor.login);

export function toActivityPr(node: ActivityNode, viewer: string): ActivityPr {
  const author = node.author?.login ?? "";
  const head = node.commits.nodes[0]?.commit;
  const reviews = node.reviews.nodes.filter((review) => review.submittedAt && review.state !== "PENDING" && !isBot(review.author));
  const review = reviews.filter((r) => r.author!.login !== author).at(-1);
  const talk = [
    ...reviews.filter((r) => r.author!.login !== viewer).map((r) => ({ at: r.submittedAt!, author: r.author!.login, kind: "review" as const, state: r.state })),
    ...node.comments.nodes.filter((c) => !isBot(c.author) && c.author!.login !== viewer).map((c) => ({ at: c.createdAt, author: c.author!.login, kind: "comment" as const })),
  ].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  return {
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    author,
    createdAt: node.createdAt,
    state: node.state,
    isDraft: node.isDraft,
    mergedAt: node.mergedAt,
    updatedAt: node.updatedAt,
    headRefName: node.headRefName,
    baseRefName: node.baseRefName,
    headOid: node.headRefOid,
    reviewDecision: node.reviewDecision,
    mergeable: node.mergeable ?? "UNKNOWN",
    checks: head?.statusCheckRollup?.state ?? "NONE",
    lastCommit: head ? { at: head.committedDate, author: head.author?.user?.login ?? head.author?.name ?? "", oid: head.oid } : null,
    lastReview: review ? { at: review.submittedAt!, author: review.author!.login, state: review.state, onHead: review.commit?.oid === node.headRefOid } : null,
    lastTalk: talk ?? null,
    unresolvedThreads: node.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
    // GitHub drops a request once that reviewer submits, so these are the ones still owed.
    requestedReviewers: (node.reviewRequests?.nodes ?? [])
      .map(({ requestedReviewer: r }) => (r?.__typename === "Team" ? `@${r.slug}` : r?.login))
      .filter((login): login is string => Boolean(login)),
    reviewers: [...new Set(reviews.filter((r) => r.author!.login !== author).reverse().map((r) => r.author!.login))],
    viewerReviewOid: reviews.filter((r) => r.author!.login === viewer).at(-1)?.commit?.oid ?? null,
  };
}

// GitHub takes nothing else as an owner or repository name, and both go into
// the query as literals.
const REPO = /^[\w.-]+\/[\w.-]+$/;
const BATCH = 25;

/** A PR the user cannot see fails its alias only; gh still exits non-zero,
 *  with the rest of the data on stdout. */
async function graphql<T>(query: string): Promise<T> {
  try {
    const { stdout } = await exec("gh", ["api", "graphql", "-f", `query=${query}`], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    return (JSON.parse(stdout) as { data: T }).data;
  } catch (error) {
    const partial = (() => {
      try {
        return (JSON.parse((error as { stdout?: string }).stdout ?? "") as { data?: T | null }).data;
      } catch {
        return undefined;
      }
    })();
    if (partial) return partial;
    throw error;
  }
}

async function fetchPrs(refs: { repo: string; number: number }[]): Promise<{ viewer: string; prs: ActivityPr[] }> {
  let viewer = "";
  const nodes: ActivityNode[] = [];
  // At least one query, for the viewer, even with nothing to look up.
  for (let from = 0; from === 0 || from < refs.length; from += BATCH) {
    const aliases = refs.slice(from, from + BATCH).map(({ repo, number }, i) => {
      const [owner, name] = repo.split("/");
      return `pr${i}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) { ${FIELDS} } }`;
    });
    const data = await graphql<Record<string, { pullRequest?: ActivityNode | null; login?: string } | null>>(`query { viewer { login } ${aliases.join(" ")} }`);
    viewer = data.viewer?.login ?? viewer;
    for (const [alias, entry] of Object.entries(data))
      if (alias !== "viewer" && entry?.pullRequest) nodes.push(entry.pullRequest);
  }
  return { viewer, prs: nodes.map((node) => toActivityPr(node, viewer)) };
}

const cacheKey = () => `board_activity@${getSettings().activeWorkspace}`;
const seenKey = () => `activity_seen@${getSettings().activeWorkspace}`;
const REFRESH_MS = 2 * 60_000;
const listeners = new Set<(activity: BoardActivity) => void>();
const seenListeners = new Set<(seen: ActivitySeen) => void>();
let timer: NodeJS.Timeout | undefined;
let inflight: Promise<BoardActivity> | undefined;

export function getBoardActivity(): BoardActivity | undefined {
  return kvGet<BoardActivity>(cacheKey());
}

export function getActivitySeen(): ActivitySeen | undefined {
  return kvGet<ActivitySeen>(seenKey());
}

export function onBoardActivityChanged(cb: (activity: BoardActivity) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function onActivitySeenChanged(cb: (seen: ActivitySeen) => void): () => void {
  seenListeners.add(cb);
  return () => seenListeners.delete(cb);
}

function saveSeen(seen: ActivitySeen): ActivitySeen {
  kvSet(seenKey(), seen);
  for (const cb of seenListeners) cb(seen);
  return seen;
}

/** Records the tickets and PRs as seen in their current state; a ticket
 *  takes its PRs with it. */
export function markActivitySeen(target: SeenTarget): ActivitySeen {
  const activity = getBoardActivity();
  const issues = getBoardCache()?.issues ?? [];
  const seen = getActivitySeen() ?? { tickets: {}, prs: {} };
  const at = new Date().toISOString();
  const prKeys = new Set(target.prs ?? []);
  for (const key of target.tickets ?? []) {
    const issue = issues.find((i) => i.key === key);
    if (issue) seen.tickets[key] = { status: issue.statusName, at };
    for (const pr of activity?.tickets[key] ?? []) prKeys.add(pr);
  }
  for (const key of prKeys) {
    const pr = activity?.prs[key];
    if (pr) seen.prs[key] = markPr(pr, at);
  }
  return saveSeen(seen);
}

/** The PRs to follow: every board card's (bar the ones closed unmerged) and
 *  every one the inbox lists, so the reviews rail has them too. */
async function collectRefs(): Promise<{ tickets: Record<string, string[]>; refs: Map<string, { repo: string; number: number }> }> {
  const refs = new Map<string, { repo: string; number: number }>();
  const tickets: Record<string, string[]> = {};
  const add = (pr: { repo: string; number: number }) => {
    if (!REPO.test(pr.repo) || !Number.isInteger(pr.number)) return false;
    refs.set(prKey(pr), { repo: pr.repo, number: pr.number });
    return true;
  };
  // The warmer keeps the cache fresh; only a card it has not reached yet is
  // looked up here, one at a time, since GitHub's search quota is small.
  for (const issue of getBoardCache()?.issues ?? []) {
    const prs = cachedPrsForIssue(issue.key) ?? (await prsForIssue(issue.key, issue).catch(() => []));
    tickets[issue.key] = prs.filter((pr) => pr.state !== "CLOSED" && add(pr)).map(prKey);
  }
  const inbox = getPrInbox();
  for (const pr of [...(inbox?.mine ?? []), ...(inbox?.reviewRequested ?? []), ...(inbox?.reviewed ?? []), ...(inbox?.reviewColumn ?? [])]) add(pr);
  return { tickets, refs };
}

export function refreshBoardActivity(): Promise<BoardActivity> {
  inflight ??= (async () => {
    const key = cacheKey();
    const { tickets, refs } = await collectRefs();
    const { viewer, prs } = await fetchPrs([...refs.values()]);
    const activity: BoardActivity = { viewer, prs: Object.fromEntries(prs.map((pr) => [prKey(pr), pr])), tickets, at: Date.now() };
    kvSet(key, activity);
    // A workspace switch mid-fetch: this belongs to the one it started in.
    if (key !== cacheKey()) return activity;
    for (const cb of listeners) cb(activity);
    // The first fetch in a workspace is the baseline: what is there already
    // is not news. Not before the board has synced, or every card would
    // arrive as new on the next one.
    if (!getActivitySeen() && (getBoardCache() || !boardConfigured()))
      markActivitySeen({ tickets: Object.keys(tickets), prs: Object.keys(activity.prs) });
    return activity;
  })().finally(() => (inflight = undefined));
  return inflight;
}

export function startBoardActivity(): void {
  const tick = () => void refreshBoardActivity().catch(() => {});
  // Behind the board sync and the inbox, whose caches this reads.
  setTimeout(tick, 10_000);
  timer = setInterval(tick, REFRESH_MS);
}

export function stopBoardActivity(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
