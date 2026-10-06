import { useEffect, useMemo, useState } from "react";
import type { ActivitySeen, BoardActivity } from "../../../main/boardActivity.js";
import type { BoardCache, BoardIssue } from "../../../main/board/types.js";
import { activityRows, ballFrom, prChanges, summarizeBalls, ticketBall, type ActivityPr, type ActivityRow, type BallState } from "../../../shared/activity.js";
import { agentsForTicket, needsYou, type AgentLink, type LinkedAgent } from "../../../shared/agentLinks.js";
import { prKey } from "../../../shared/prs.js";
import { useAgentLinks } from "./useAgentLinks.js";
import { usePrInbox } from "./useInbox.js";
import { useSettings } from "./useSettings.js";

/** PR activity and the user's seen marks, kept in sync via pushes. */
export function useBoardActivity(): { activity?: BoardActivity; seen?: ActivitySeen } {
  const [activity, setActivity] = useState<BoardActivity>();
  const [seen, setSeen] = useState<ActivitySeen>();
  useEffect(() => {
    void window.deck.activity.get().then(setActivity);
    void window.deck.activity.seen().then(setSeen);
    const offActivity = window.deck.activity.onChanged(setActivity);
    const offSeen = window.deck.activity.onSeenChanged(setSeen);
    return () => { offActivity(); offSeen(); };
  }, []);
  return { activity, seen };
}

/** One row per board ticket, new ones first. Empty until the board, the PR
 *  activity and the seen marks are all in. */
export function useActivityRows() {
  const { activity, seen } = useBoardActivity();
  const [board, setBoard] = useState<BoardCache>();
  const settings = useSettings();
  useEffect(() => {
    void window.deck.board.get().then(setBoard);
    return window.deck.board.onChanged(setBoard);
  }, []);
  const rows = useMemo(() => {
    if (!board || !activity || !seen || !settings) return [];
    const { reviewColumns, onMerge } = settings.board;
    return activityRows(board.issues, board.columns, activity, seen, { reviewColumns, doneColumn: onMerge.enabled ? onMerge.column : undefined });
  }, [board, activity, seen, settings]);
  const unread = useMemo(() => rows.filter((row) => row.changes.length > 0).length, [rows]);
  return { rows, unread, board, activity, seen, loaded: Boolean(board && activity && seen) };
}

/** Why a PR reads as new; empty when it does not, or while nothing is loaded
 *  to tell. */
export function prNews(pr: { repo: string; number: number }, activity: BoardActivity | undefined, seen: ActivitySeen | undefined): string[] {
  const current = activity?.prs[prKey(pr)];
  return current && seen ? prChanges(current, seen.prs[prKey(pr)], activity.viewer) : [];
}

/** A ticket's ball, with the PR it is on and the agent waiting on the user when that is it. */
export type RowBall = BallState & { pr?: ActivityPr; agent?: LinkedAgent };

/** One ball per ticket, from its open PRs and any agent of it waiting on the
 *  user; merged work on a ticket that has not moved is its assignee's move. */
export function rowBall(row: ActivityRow<BoardIssue>, viewer: string, requested: Set<string>, links: AgentLink[], myAccountId?: string): RowBall | undefined {
  const open = row.prs.filter((pr) => pr.state === "OPEN");
  const waiting = agentsForTicket(row.issue.key, row.prs, links).find((agent) => needsYou(agent.link.status));
  if (open.length === 0 && !waiting) {
    const merged = row.prs.filter((pr) => pr.state === "MERGED").sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""))[0];
    if (!merged || row.done) return undefined;
    const mine = Boolean(myAccountId) && row.issue.assigneeId === myAccountId;
    return { stance: mine ? "you" : "others", who: mine ? [viewer] : [row.issue.assignee ?? "the assignee"], action: "move ticket", since: merged.mergedAt ?? merged.updatedAt };
  }
  const states = open.map((pr) => ({ pr, state: ballFrom(pr, viewer, requested.has(prKey(pr))) }));
  const best = ticketBall(states.map(({ state }) => state), waiting && { since: new Date(waiting.link.updatedAt).toISOString() });
  return best && { ...best, pr: states.find(({ state }) => state === best)?.pr ?? states[0]?.pr, agent: best.action === "answer agent" ? waiting : undefined };
}

/** A done ticket with a PR still open is not done for whoever holds that PR. */
export const rowActive = (row: ActivityRow<BoardIssue>): boolean => !row.done || row.prs.some((pr) => pr.state === "OPEN");

/** Agents waiting on the user that no live ticket row accounts for, so they
 *  still show up where the user looks for whose move it is. */
export function looseWaitingAgents(rows: ActivityRow<BoardIssue>[], links: AgentLink[]): AgentLink[] {
  const onTickets = new Set(rows.filter(rowActive).flatMap((row) => agentsForTicket(row.issue.key, row.prs, links).map((agent) => agent.link.sessionId)));
  return links.filter((link) => needsYou(link.status) && !onTickets.has(link.sessionId));
}

/** A loose waiting agent as a ball, so it counts like any other move of the user's. */
export const agentBall = (link: AgentLink): BallState => ({ stance: "you", who: [], action: "answer agent", since: new Date(link.updatedAt).toISOString() });

/** Everything waiting on the user, counted once: the sidebar's one badge,
 *  the same number as the activity page's "waiting on you". */
export function useYourMove(): { count: number; news: number } {
  const { rows, unread, board, activity } = useActivityRows();
  const inbox = usePrInbox();
  const links = useAgentLinks();
  const count = useMemo(() => {
    const viewer = activity?.viewer ?? "";
    const requested = new Set((inbox?.reviewRequested ?? []).map(prKey));
    const balls = rows.filter(rowActive).map((row) => rowBall(row, viewer, requested, links, board?.myAccountId));
    return summarizeBalls([...balls, ...looseWaitingAgents(rows, links).map(agentBall)]).you;
  }, [rows, activity, inbox, links, board]);
  return { count, news: unread };
}
