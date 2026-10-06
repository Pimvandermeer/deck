import { useEffect, useMemo, useState } from "react";
import type { ActivitySeen, BoardActivity } from "../../../main/boardActivity.js";
import type { BoardCache } from "../../../main/board/types.js";
import { activityRows, prChanges } from "../../../shared/activity.js";
import { prKey } from "../../../shared/prs.js";
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
