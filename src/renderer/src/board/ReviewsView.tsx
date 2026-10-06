import { useEffect, useMemo, useRef, useState } from "react";
import type { IssuePr, ReviewEvent } from "../../../main/github.js";
import type { InboxPr } from "../../../main/prInbox.js";
import type { ActivitySeen, BoardActivity } from "../../../shared/activity.js";
import { prKey } from "../../../shared/prs.js";
import { navigateBack, onOpenPullRequest, type OpenPrDetail } from "../lib/bus.js";
import { issueFor, useReviewQueue } from "../lib/reviews.js";
import { prNews, useBoardActivity } from "../lib/useActivity.js";
import { useAgentLinks } from "../lib/useAgentLinks.js";
import { usePrInbox } from "../lib/useInbox.js";
import { agentsForPr, type AgentLink } from "../../../shared/agentLinks.js";
import type { BoardCache } from "../../../main/board/types.js";
import { AgentChip } from "./AgentLinks.js";
import { Icon } from "./icons.js";
import { PrScreen } from "./PrScreen.js";
import { MovePill, moveOf } from "./prUi.js";

// The review queue: every PR waiting on the user's review, one at a time,
// with next/previous like a mail client. Approving or requesting changes
// stays put, since merging usually follows an approval; the PR screen
// underneath is the same one the board opens.

const isTyping = (e: KeyboardEvent) => ["TEXTAREA", "INPUT", "SELECT"].includes((e.target as HTMLElement)?.tagName ?? "");

const toIssuePr = (pr: InboxPr): IssuePr => ({ repo: pr.repo, number: pr.number, title: pr.title, state: "OPEN", isDraft: pr.isDraft, url: pr.url, author: pr.author, updatedAt: pr.updatedAt });


const checkTone: Record<string, string> = { SUCCESS: "text-green", FAILURE: "text-red", ERROR: "text-red", PENDING: "text-orange" };
const checkLabel: Record<string, string> = { SUCCESS: "Checks passed", FAILURE: "Checks failed", ERROR: "Checks errored", PENDING: "Checks running", EXPECTED: "Checks expected" };

function PrList({ title, prs, current, badge, onPick, activity, seen, links = [], board, requested = new Set() }: {
  title: string;
  prs: InboxPr[];
  current?: InboxPr;
  badge?: (pr: InboxPr) => string | undefined;
  onPick: (pr: InboxPr) => void;
  activity?: BoardActivity;
  seen?: ActivitySeen;
  links?: AgentLink[];
  board?: BoardCache;
  requested?: Set<string>;
}) {
  if (prs.length === 0) return null;
  const news = new Map(prs.map((pr) => [prKey(pr), prNews(pr, activity, seen)]));
  // New ones first; sort is stable, so the inbox order holds within each part.
  const ordered = [...prs].sort((a, b) => Number(news.get(prKey(b))!.length > 0) - Number(news.get(prKey(a))!.length > 0));
  return (
    <section aria-label={title} className="flex flex-col gap-1 px-3 py-2.5">
      <h3 className="flex items-center gap-2 px-1 text-[10px] tracking-widest text-dim">{title.toUpperCase()}<span className="text-mut">{prs.length}</span></h3>
      {ordered.map((pr) => {
        const active = current && pr.repo === current.repo && pr.number === current.number;
        const note = badge?.(pr);
        const fresh = news.get(prKey(pr))!;
        const known = activity?.prs[prKey(pr)];
        const agent = agentsForPr(pr, issueFor(pr, board)?.key, links)[0];
        return (
          <button key={prKey(pr)} onClick={() => onPick(pr)} title={`${pr.title}\n${prKey(pr)}${fresh.length ? `\nNew: ${fresh.join(", ")}` : ""}`}
            className={`flex flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 text-left ${active ? "border-accent bg-card" : "border-transparent hover:border-edge2 hover:bg-card"}`}>
            <span className="flex items-center gap-1.5 text-[11px]">
              {fresh.length > 0 && <span aria-label="New since you last looked" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
              <span className="text-dim">#{pr.number}</span>
              <span className="min-w-0 flex-1 truncate text-soft">{pr.title}</span>
              {pr.checks !== "NONE" && (
                <span title={checkLabel[pr.checks] ?? `Checks: ${pr.checks.toLowerCase()}`} aria-label={checkLabel[pr.checks] ?? pr.checks} className={`shrink-0 ${checkTone[pr.checks] ?? "text-dim"}`}>●</span>
              )}
            </span>
            <span className="flex items-center gap-1.5 truncate text-[10px] text-dim">
              {pr.repo.split("/")[1] ?? pr.repo}{pr.author && ` · ${pr.author}`}
              {pr.mergeable === "CONFLICTING" && <span className="text-red">· merge conflicts</span>}
              {note && <span className="text-orange">· {note}</span>}
            </span>
            {known && (
              <span className="flex items-center gap-1.5 truncate text-[10px] text-dim">
                <span className="flex min-w-0"><MovePill move={moveOf(known, activity!.viewer, requested)} /></span>
                {known.unresolvedThreads > 0 && <span className="text-orange">· {known.unresolvedThreads} open</span>}
                {fresh.length > 0 && <span className="truncate text-accent">· {fresh.join(", ")}</span>}
              </span>
            )}
            {agent && <span className="flex"><AgentChip agent={agent} /></span>}
          </button>
        );
      })}
    </section>
  );
}

export function ReviewsView({ visible }: { visible: boolean }) {
  const { queue, board, loaded, reviewed: reviewedPrs, lists, source, needsColumn } = useReviewQueue();
  const { activity, seen } = useBoardActivity();
  const links = useAgentLinks();
  const inbox = usePrInbox();
  const requested = useMemo(() => new Set((inbox?.reviewRequested ?? []).map(prKey)), [inbox]);
  // What was new when the PR came up, kept after it is marked seen.
  const [arrived, setArrived] = useState<{ key: string; news: string[] }>();
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string>();
  const [rail, setRail] = useState(() => localStorage.getItem("deck.reviews.rail") !== "hidden");
  const [reviewed, setReviewed] = useState<{ key: string; event: ReviewEvent }>();
  // A PR opened from another page or a stack link, which need not be in the
  // queue at all; fromPage says whether Back leaves the reviews page.
  const [linked, setLinked] = useState<OpenPrDetail & { fromPage: boolean }>();

  const toggleRail = () => setRail((open) => { localStorage.setItem("deck.reviews.rail", open ? "hidden" : "visible"); return !open; });
  // Leaving the page drops the linked PR so the queue shows next time; the
  // link arrives while the page is still hidden, so only visible→hidden counts.
  const wasVisible = useRef(visible);
  // A stack link followed here keeps where the first PR came from.
  useEffect(() => onOpenPullRequest((pr) => setLinked((prev) => ({ ...pr, fromPage: wasVisible.current ? prev?.fromPage ?? false : true }))), []);
  useEffect(() => {
    if (wasVisible.current && !visible) setLinked(undefined);
    wasVisible.current = visible;
  }, [visible]);

  // A review column can hold PRs the user has already reviewed, so the
  // section below lists only the ones the queue left out.
  const alsoReviewed = lists.reviewed.filter((pr) => !lists.waiting.some((q) => prKey(q) === prKey(pr)));
  const browsable = [...lists.waiting, ...alsoReviewed, ...lists.mine];
  const fromQueue = queue[Math.min(index, Math.max(queue.length - 1, 0))];
  const current = linked
    ? browsable.find((pr) => pr.repo === linked.repo && pr.number === linked.number)
      ?? { ...linked, reviewDecision: null, mergeable: "UNKNOWN", checks: "NONE", headRefName: "", baseRefName: "" }
    : (picked && browsable.find((pr) => prKey(pr) === picked)) || fromQueue;
  const position = current ? queue.indexOf(current) : -1;

  // Picking a queued PR moves the queue position to it; anything else is
  // shown without touching the queue.
  const pick = (pr: InboxPr) => {
    const at = queue.indexOf(pr);
    setLinked(undefined);
    if (at >= 0) { setIndex(at); setPicked(undefined); } else setPicked(prKey(pr));
  };
  const issue = (linked?.issueKey ? board?.issues.find((i) => i.key === linked.issueKey) : undefined) ?? (current ? issueFor(current, board) : undefined);

  const go = (delta: number) => {
    const from = position >= 0 ? position : index;
    setPicked(undefined);
    setLinked(undefined);
    setIndex(Math.min(Math.max(from + delta, 0), Math.max(queue.length - 1, 0)));
  };

  const onReviewed = (event: ReviewEvent) => {
    if (!current || event === "COMMENT") return;
    setReviewed({ key: prKey(current), event });
    // Pick up the review so the PR reads as reviewed rather than waiting.
    void window.deck.inbox.refresh();
  };

  // Marked seen after a short look, so stepping through with n/p does not
  // clear everything it passes.
  const currentKey = current ? prKey(current) : undefined;
  const currentNews = current ? prNews(current, activity, seen) : [];
  useEffect(() => {
    if (arrived && arrived.key !== currentKey) setArrived(undefined);
    if (!visible || !currentKey || currentNews.length === 0) return;
    setArrived({ key: currentKey, news: currentNews });
    const timer = setTimeout(() => void window.deck.activity.markSeen({ prs: [currentKey] }), 1500);
    return () => clearTimeout(timer);
  }, [visible, currentKey, currentNews.join("|")]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" || e.key === "]") go(1);
      else if (e.key === "p" || e.key === "[") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className={`${visible ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col`}>
      <div className="flex items-center gap-3 border-b border-edge px-6 py-3">
        {linked && <button aria-label="Back" title={linked.fromPage ? "Back to where this PR was opened" : "Back to the review queue"} onClick={() => { setLinked(undefined); if (linked.fromPage) navigateBack(); }} className="-ml-1.5 rounded px-1.5 py-0.5 text-[11px] text-dim hover:bg-card2 hover:text-ink">‹ Back</button>}
        <span className="font-bold text-ink">Reviews</span>
        <span className="text-[11px] text-dim">{queue.length === 0 ? "nothing waiting on you" : position < 0 ? `not in your queue · ${queue.length} waiting` : `${position + 1} of ${queue.length}`}</span>
        {/* One chip: what just arrived beats the standing review state. */}
        {current && (arrived?.key === prKey(current)
          ? <span title={arrived.news.join("\n")} className="truncate rounded border border-accent/40 px-1.5 py-0.5 font-sans text-[10px] text-accent">new: {arrived.news.join(" · ")}</span>
          : reviewedPrs.has(prKey(current)) && (reviewedPrs.get(prKey(current))
            ? <span title="You reviewed this and the author has pushed since" className="rounded border border-orange/40 px-1.5 py-0.5 font-sans text-[10px] text-orange">new since your review</span>
            : <span title="You reviewed this; nothing new since" className="rounded border border-edge3 px-1.5 py-0.5 font-sans text-[10px] text-dim">reviewed</span>))}
        {issue && (
          <button onClick={() => window.open(issue.url)} className="flex min-w-0 items-center gap-1.5 truncate font-sans text-[11px] text-body hover:text-ink" title={`Open ${issue.key}`}>
            <Icon name="issue" size={11} className="text-dim" /><span className="text-mut">{issue.key}</span><span className="truncate">{issue.summary}</span><span className="shrink-0 text-dim">· {issue.statusName}</span>
          </button>
        )}
        {current && reviewed?.key === prKey(current) && <span className={`text-[11px] ${reviewed.event === "APPROVE" ? "text-green" : "text-red"}`}>{reviewed.event === "APPROVE" ? "✓ approved" : "✗ changes requested"}</span>}
        <span className="ml-auto flex items-center gap-1 text-[11px] text-dim">
          <button aria-label="Previous review" title="Previous (p)" disabled={position <= 0} onClick={() => go(-1)} className="rounded px-1.5 py-0.5 hover:bg-card2 hover:text-ink disabled:opacity-30">‹ prev</button>
          <button aria-label="Next review" title="Next (n)" disabled={position < 0 || position >= queue.length - 1} onClick={() => go(1)} className="rounded px-1.5 py-0.5 hover:bg-card2 hover:text-ink disabled:opacity-30">next ›</button>
          <button onClick={toggleRail} aria-pressed={rail} aria-label="Toggle pull request list" title="All open pull requests" className={`rounded p-1 ${rail ? "bg-card2 text-soft" : "text-dim hover:text-ink"}`}><Icon name="sidebar" size={14} /></button>
        </span>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {current ? (
            <PrScreen key={prKey(current)} embedded hidden={!visible} pr={toIssuePr(current)} issue={issue} onClose={() => {}} onReviewed={onReviewed} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[12px] text-dim">
              <Icon name="check" size={20} className="text-green" />
              {needsColumn
                ? "Pick the board column the reviews queue reads in Settings → Board."
                : loaded ? "Inbox zero: no pull requests are waiting on your review." : "Waiting for GitHub…"}
            </div>
          )}
        </div>
        {rail && (
          <aside aria-label="Open pull requests" className="flex w-[268px] shrink-0 flex-col overflow-y-auto border-l border-edge font-sans">
            <PrList title={source === "board" ? "In the review column" : "Needs your review"} prs={lists.waiting} current={current} onPick={pick}
              badge={(pr) => (pr.newSinceReview ? "new since your review" : undefined)} activity={activity} seen={seen} links={links} board={board} requested={requested} />
            <PrList title="You reviewed" prs={alsoReviewed} current={current} onPick={pick}
              badge={(pr) => (pr.newSinceReview ? "new since your review" : undefined)} activity={activity} seen={seen} links={links} board={board} requested={requested} />
            <PrList title="Your PRs" prs={lists.mine} current={current} onPick={pick} activity={activity} seen={seen} links={links} board={board} requested={requested} />
            {browsable.length === 0 && <p className="px-4 py-3 text-[11px] text-dim">{loaded ? "No open pull requests." : "Waiting for GitHub…"}</p>}
          </aside>
        )}
      </div>
    </div>
  );
}
