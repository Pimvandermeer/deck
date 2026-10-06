import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardCache, BoardIssue } from "../../../main/board/types.js";
import { isDone, type ActivityPr } from "../../../shared/activity.js";
import { agentsForTicket } from "../../../shared/agentLinks.js";
import { boardProviderLabels } from "../../../shared/board.js";
import { prKey } from "../../../shared/prs.js";
import type { DeckSettings } from "../../../shared/settings.js";
import { BoardConnectionFields, boardConnected, boardConnectionHelp } from "../chrome/BoardConnectionFields.js";
import { HeaderButton, PageHeader } from "../chrome/PageHeader.js";
import { onNavBack, openPullRequest } from "../lib/bus.js";
import { rowActive, rowBall, useActivityRows } from "../lib/useActivity.js";
import { useAgentLinks } from "../lib/useAgentLinks.js";
import { usePrInbox } from "../lib/useInbox.js";
import { AgentChip } from "./AgentLinks.js";
import { BoardFilterBar, filterBoardIssues, noBoardFilters, type BoardFilters } from "./BoardFilters.js";
import { useTabs } from "../store.js";
import { Icon } from "./icons.js";
import { IssuePanel } from "./IssuePanel.js";
import { MovePill, moveOf, relativeTime } from "./prUi.js";

// Orange is kept for the user's move, so no column dot uses it.
const columnDots = ["border-[1.5px] border-mut", "bg-accent", "bg-blue", "bg-green", "bg-soft"];
const ciDots: Record<string, string> = { SUCCESS: "bg-green", FAILURE: "bg-red", ERROR: "bg-red", PENDING: "border-[1.5px] border-mut", EXPECTED: "border-[1.5px] border-mut" };
const ciWords: Record<string, string> = { SUCCESS: "Checks passed", FAILURE: "Checks failing", ERROR: "Checks errored", PENDING: "Checks running", EXPECTED: "Checks expected" };
const COLLAPSED_KEY = "deck.board.collapsedColumns";
const MINE_ONLY_KEY = "deck.board.mineOnly";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
const avatarColors = ["#f87171", "#4ade80", "#38bdf8", "#a78bfa", "#fb923c", "#7dcfff"];

function initials(name: string | null): string {
  if (!name) return "·";
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

function avatarColor(name: string | null): string {
  if (!name) return "#23252d";
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
  return avatarColors[h % avatarColors.length];
}

export function BoardView({ visible = true }: { visible?: boolean }) {
  const { newTab } = useTabs();
  const [board, setBoard] = useState<BoardCache>();
  const [settings, setSettings] = useState<DeckSettings>();
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string>();
  const [selected, setSelected] = useState<BoardIssue>();
  const [filters, setFilters] = useState<BoardFilters>(() => ({
    ...noBoardFilters,
    mineOnly: localStorage.getItem(MINE_ONLY_KEY) === "true",
  }));
  const saveSettings = async (patch: Partial<DeckSettings>) => setSettings(await window.deck.updateSettings(patch));
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [dragKey, setDragKey] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const [moveError, setMoveError] = useState<string>();
  const { rows, activity, loaded } = useActivityRows();
  const inbox = usePrInbox();
  const links = useAgentLinks();

  const toggleCollapsed = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  useEffect(() => {
    void window.deck.getSettings().then(setSettings);
    void window.deck.board.get().then(setBoard);
    const offChanged = window.deck.board.onChanged((next) => { setBoard(next); setSyncError(undefined); });
    const offError = window.deck.board.onSyncError(setSyncError);
    return () => { offChanged(); offError(); };
  }, []);

  // Mouse-back closes the issue panel before the view history moves, but not
  // while the board sits hidden behind another page. Refs mirror the state
  // because the dispatch needs a synchronous answer.
  const overlayRef = useRef({ visible: true, panel: false });
  overlayRef.current = { visible, panel: Boolean(selected) };
  useEffect(
    () =>
      onNavBack((e) => {
        if (overlayRef.current.visible && overlayRef.current.panel) {
          e.preventDefault();
          setSelected(undefined);
        }
      }),
    [],
  );

  const rejectedRe = useMemo(() => {
    try {
      return new RegExp(settings?.board.rejectedPattern || "reject", "i");
    } catch {
      return /reject/i;
    }
  }, [settings]);

  const configured = Boolean(settings && boardConnected(settings));

  // Per ticket: its row, whose move it is, and the PR and agent its card shows.
  const cardInfo = useMemo(() => {
    const viewer = activity?.viewer ?? "";
    const requested = new Set((inbox?.reviewRequested ?? []).map(prKey));
    return new Map(rows.map((row) => {
      const ball = rowActive(row) ? rowBall(row, viewer, requested, links, board?.myAccountId) : undefined;
      const pr: ActivityPr | undefined = ball?.pr ?? row.prs.find((p) => p.state === "OPEN") ?? row.prs[0];
      return [row.issue.key, {
        row,
        yours: ball?.stance === "you",
        pr,
        move: pr && moveOf(pr, viewer, requested),
        agent: agentsForTicket(row.issue.key, row.prs, links)[0],
      }] as const;
    }));
  }, [rows, activity, inbox, links, board?.myAccountId]);
  const yourMoveKeys = useMemo(
    () => (loaded ? new Set([...cardInfo].filter(([, info]) => info.yours).map(([key]) => key)) : undefined),
    [cardInfo, loaded],
  );
  const doneRules = settings && { reviewColumns: settings.board.reviewColumns, doneColumn: settings.board.onMerge.enabled ? settings.board.onMerge.column : undefined };

  // Older caches have no account id, so "mine" can only be honoured once a
  // sync has recorded who we are.
  const canFilterMine = Boolean(board?.myAccountId);
  const issues = useMemo(
    () => (board ? filterBoardIssues(board.issues, filters, board.myAccountId, yourMoveKeys) : []),
    [board, filters, yourMoveKeys],
  );

  const updateFilters = (patch: Partial<BoardFilters>) => {
    if (patch.mineOnly !== undefined) localStorage.setItem(MINE_ONLY_KEY, String(patch.mineOnly));
    setFilters((prev) => ({ ...prev, ...patch }));
  };

  // Optimistic: the card lands in the column at once; a failed transition
  // puts the real board back and says why.
  const moveTo = async (columnName: string) => {
    const key = dragKey;
    setDragKey(undefined);
    setDropTarget(undefined);
    const column = board?.columns.find((c) => c.name === columnName);
    const issue = board?.issues.find((i) => i.key === key);
    if (!board || !column || !issue || column.statusIds.includes(issue.statusId)) return;
    const before = board;
    setBoard({
      ...board,
      issues: board.issues.map((i) =>
        i.key === key ? { ...i, statusId: column.statusIds[0], statusName: columnName } : i,
      ),
    });
    setMoveError(undefined);
    try {
      setBoard(await window.deck.board.move(issue.key, columnName));
    } catch (err) {
      setBoard(before);
      setMoveError(err instanceof Error ? err.message.replace(/^Error invoking.*?: /, "") : String(err));
    }
  };

  const dropProps = (columnName: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragKey) return;
      e.preventDefault();
      if (dropTarget !== columnName) setDropTarget(columnName);
    },
    onDragLeave: () => setDropTarget((t) => (t === columnName ? undefined : t)),
    onDrop: () => void moveTo(columnName),
  });

  const spinUp = (issue: BoardIssue) => {
    const prompt = `${issue.key}: ${issue.summary} — the code was rejected in review. Look at the PR feedback and address it.`;
    void newTab({ prompt, issueKey: issue.key });
  };

  if (!configured) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PageHeader title="Board" sub="not connected" />
        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-8 font-sans">
          <div className="mx-auto max-w-[560px]">
            <h2 className="text-base font-semibold text-ink">Connect your board</h2>
            <p className="mt-1 text-xs leading-5 text-mut">
              Your board appears here as a Kanban view. Cards launch a Claude Code or Codex session
              on their ticket, and dragging one between columns moves the ticket itself.
            </p>
            {settings && <div className="mt-6 rounded-xl border border-edge2 bg-panel p-5">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-card2 text-accent"><Icon name="issue" size={17} /></span>
                <div className="flex-1">
                  <div className="text-xs font-medium text-soft">{boardProviderLabels[settings.board.provider]}</div>
                  <p className="mt-0.5 text-[11px] text-mut">Sync a board, drag cards to move them in the tracker.</p>
                </div>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-4">
                <BoardConnectionFields settings={settings} onChange={(patch) => void saveSettings(patch)} />
              </div>
              <p className="mt-4 text-[11px] text-mut">
                {boardConnectionHelp(settings.board.provider).help}
                {boardConnectionHelp(settings.board.provider).tokenPage && <>
                  {" "}<button onClick={() => window.open(boardConnectionHelp(settings.board.provider).tokenPage)} className="text-accent hover:underline">Open the token page ↗</button>
                </>}
              </p>
            </div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Board"
        sub={syncError ? "sync failed" : board ? <span className="min-w-0 truncate">{board.boardName} · <span className="font-mono">{board.issues.length}</span> issues</span> : "syncing…"}
      >
        {board?.at ? <span className="font-mono text-[11px] text-mut" title={new Date(board.at).toLocaleString()}>synced {relativeTime(new Date(board.at).toISOString())}</span> : null}
        <HeaderButton
          onClick={async () => {
            setSyncing(true);
            setBoard((await window.deck.board.sync()) ?? board);
            setSyncing(false);
          }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 2.5v3h-3" /></svg>
          {syncing ? "Syncing…" : "Sync"}
        </HeaderButton>
      </PageHeader>
      {syncError && board && <div role="alert" className="border-b border-edge bg-red/10 px-7 py-2 font-sans text-xs text-red">{syncError}</div>}
      {syncError && !board && (
        <div role="alert" className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-7 py-8 font-sans">
          <div className="max-w-[560px] rounded-xl border border-edge2 bg-panel p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-red/10 text-red"><Icon name="issue" size={17} /></span>
              <div>
                <h2 className="text-sm font-semibold text-ink">Deck can't reach your {settings ? boardProviderLabels[settings.board.provider] : ""} board</h2>
                <p className="mt-0.5 text-[11px] text-mut">Nothing is shown until a sync succeeds.</p>
              </div>
            </div>
            <p className="mt-4 rounded-md bg-card px-3 py-2 font-mono text-[11px] leading-5 text-red">{syncError}</p>
            {settings && <p className="mt-3 text-[11px] leading-5 text-mut">{boardConnectionHelp(settings.board.provider).help}</p>}
            <button onClick={async () => { setSyncing(true); setBoard((await window.deck.board.sync()) ?? board); setSyncing(false); }}
              className="mt-4 rounded-md border border-edge2 px-3 py-1.5 text-xs text-body hover:border-edge3">{syncing ? "Retrying…" : "Retry sync"}</button>
          </div>
        </div>
      )}
      {board && (
        <BoardFilterBar
          issues={board.issues}
          filters={filters}
          onChange={updateFilters}
          canFilterMine={canFilterMine}
          shown={issues.length}
          yourMove={yourMoveKeys && board.issues.filter((i) => yourMoveKeys.has(i.key)).length}
        />
      )}
      {moveError && (
        <div className="flex items-center gap-3 border-b border-red/30 bg-red/10 px-6 py-1.5 text-[11px] text-red">
          <span className="min-w-0 flex-1 truncate">{moveError}</span>
          <button onClick={() => setMoveError(undefined)} className="hover:text-ink">
            ✕
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
      <div className="flex flex-1 items-start gap-4 overflow-auto px-6 py-5">
        {board?.columns.map((col, ci) => {
          const cards = issues.filter((i) => col.statusIds.includes(i.statusId));
          const dot = <span className={`h-2 w-2 shrink-0 rounded-full ${columnDots[ci % columnDots.length]}`} />;
          const isTarget = dropTarget === col.name;
          const yours = cards.filter((card) => cardInfo.get(card.key)?.yours).length;
          if (collapsed.has(col.name)) {
            // Jira-style collapsed column: a narrow strip with the title
            // running down it; click anywhere to expand.
            return (
              <button
                key={col.name}
                onClick={() => toggleCollapsed(col.name)}
                title={`Expand ${col.name}`}
                {...dropProps(col.name)}
                className={`flex w-9 shrink-0 flex-col items-center gap-2 rounded-xl border bg-panel/50 py-2.5 hover:border-edge3 ${
                  isTarget ? "border-accent" : "border-edge"
                }`}
              >
                {dot}
                <span
                  className="whitespace-nowrap text-[13px] font-semibold text-soft"
                  style={{ writingMode: "vertical-rl" }}
                >
                  {col.name}
                </span>
                <span className="font-mono text-[11px] text-mut">{cards.length}</span>
                {yours > 0 && <span className="font-mono text-[11px] font-semibold text-orange" title={`${yours} your move`}>{yours}</span>}
              </button>
            );
          }
          return (
            <section
              key={col.name}
              aria-label={col.name}
              {...dropProps(col.name)}
              className={`group flex w-[280px] shrink-0 flex-col gap-2 self-stretch rounded-xl p-2 ${
                isTarget ? "bg-accent/5 ring-1 ring-accent/40" : "bg-panel/50"
              }`}
            >
              <div className="flex h-[30px] items-center gap-2 px-1.5">
                {dot}
                <h2 className="min-w-0 truncate text-[13px] font-semibold text-soft">{col.name}</h2>
                <span className="font-mono text-[11px] text-mut">{cards.length}</span>
                <span className="flex-1" />
                {yours > 0 && <span className="shrink-0 text-[11px] font-semibold text-orange">{yours} your move</span>}
                <button
                  onClick={() => toggleCollapsed(col.name)}
                  title="Collapse"
                  className="text-[11px] text-mut opacity-0 hover:text-ink group-hover:opacity-100"
                >
                  →←
                </button>
              </div>
              <div className="flex flex-col gap-2">
                {cards.map((card) => {
                  const rejected = rejectedRe.test(card.statusName);
                  const info = cardInfo.get(card.key);
                  const news = Boolean(info?.row.changes.length);
                  const done = Boolean(doneRules && isDone(card, col.name, doneRules));
                  const flag = info?.row.flags[0];
                  const { pr, move, agent } = info ?? {};
                  const surface = done ? "bg-panel" : news ? "bg-overlay" : "bg-card";
                  const edge = done ? "border-card2" : news ? "border-edge2" : "border-edge";
                  return (
                    <div
                      key={card.key}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        setDragKey(card.key);
                      }}
                      onDragEnd={() => {
                        setDragKey(undefined);
                        setDropTarget(undefined);
                      }}
                      onClick={() => setSelected(card)}
                      className={`flex cursor-pointer select-none flex-col gap-2 rounded-[10px] border p-3 hover:border-edge3 ${surface} ${
                        selected?.key === card.key ? "border-accent/50" : edge
                      } ${dragKey === card.key ? "opacity-40" : ""}`}
                    >
                      <div className="flex items-center gap-[7px]">
                        {news && <span aria-label="New since you looked" title={info?.row.changes.join("\n")} className="h-[7px] w-[7px] shrink-0 rounded-full bg-ink" />}
                        <span className={`min-w-0 flex-1 truncate font-mono text-[11px] ${news ? "font-semibold text-ink" : "text-mut"}`}>
                          {card.key}
                          {card.localMove && (
                            <span
                              className="ml-1.5 font-sans font-normal text-mut"
                              title="Moved on this board only; the tracker still shows the previous column"
                            >
                              · local
                            </span>
                          )}
                        </span>
                        <span
                          className="flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px] font-bold text-bg"
                          style={{ background: avatarColor(card.assignee) }}
                          title={card.assignee ?? "unassigned"}
                        >
                          {initials(card.assignee)}
                        </span>
                      </div>
                      <div className={`text-[13px] leading-snug ${done ? "text-body" : `text-ink ${news ? "font-semibold" : "font-medium"}`}`}>{card.summary}</div>
                      {rejected && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            spinUp(card);
                          }}
                          className="self-start text-[11px] text-red hover:underline"
                        >
                          ✗ code rejected — ⏎ spin up agent
                        </button>
                      )}
                      {(pr || agent || flag) && (
                        <div className="mt-0.5 flex flex-col gap-2 border-t border-edge/60 pt-2.5">
                          {(pr || agent) && (
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              {pr && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openPullRequest({ repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, author: pr.author, isDraft: pr.isDraft, updatedAt: pr.updatedAt, issueKey: card.key });
                                  }}
                                  title={`${pr.title}\n${prKey(pr)}`}
                                  className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-soft hover:text-ink hover:underline"
                                >
                                  {pr.state === "OPEN" && <span title={ciWords[pr.checks] ?? "No checks"} className={`box-border h-1.5 w-1.5 shrink-0 rounded-full ${ciDots[pr.checks] ?? "bg-edge3"}`} />}
                                  {pr.repo.split("/")[1] ?? pr.repo}#{pr.number}
                                </button>
                              )}
                              {move && <MovePill move={move} />}
                              {agent && <AgentChip agent={agent} />}
                            </div>
                          )}
                          {flag && (
                            <span className="flex items-center gap-1.5 text-[12px] text-red">
                              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><path d="M8 2.5 14 13.5H2Z" /><path d="M8 7v3" /><path d="M8 12h.01" /></svg>
                              {flag.charAt(0).toUpperCase() + flag.slice(1)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {selected && settings && (
        <IssuePanel
          issue={selected}
          rejected={rejectedRe.test(selected.statusName)}
          onClose={() => setSelected(undefined)}
          onOpenDiff={(pr) => openPullRequest({ repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, author: pr.author, isDraft: pr.isDraft, updatedAt: pr.updatedAt, issueKey: selected.key })}
        />
      )}
      </div>
    </div>
  );
}
