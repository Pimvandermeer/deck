import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { IssuePr } from "../../../main/github.js";
import type { BoardIssue } from "../../../main/board/types.js";
import { ballText, stackedOn, summarizeBalls, type ActivityPr, type ActivityRow, type BallSummary, type Stance } from "../../../shared/activity.js";
import { agentsForPr, agentsForTicket, type AgentLink, type PastSession } from "../../../shared/agentLinks.js";
import { agentLabels, type Agent } from "../../../shared/agents.js";
import type { RepoDir } from "../../../main/providers.js";
import { prKey } from "../../../shared/prs.js";
import { agentBall, looseWaitingAgents, rowActive, rowBall, useActivityRows, type RowBall } from "../lib/useActivity.js";
import { focusTerminal, openPullRequest } from "../lib/bus.js";
import { StatusMark, statusLabels, statusTones } from "../chrome/SessionIcon.js";
import { HeaderButton, PageHeader } from "../chrome/PageHeader.js";
import { useAgentLinks } from "../lib/useAgentLinks.js";
import { AgentChip, ContinueButton, continuation, type Continuation } from "./AgentLinks.js";
import { usePrInbox } from "../lib/useInbox.js";
import { useSettings } from "../lib/useSettings.js";
import { Icon } from "./icons.js";
import { IssuePanel } from "./IssuePanel.js";
import { MovePill, moveOf, relativeTime, type Move } from "./prUi.js";

// Every board ticket with its PRs, grouped by whose move it is (waiting on
// the user, the user waiting on someone, or between others) or by what
// changed since the user last looked. Each PR says whose move it is in words.

type Row = ActivityRow<BoardIssue>;
type Filter = "all" | "mine" | "agents";
type GroupBy = "ball" | "news";

const DONE_KEY = "deck.activity.showDone";
const COLLAPSED_KEY = "deck.activity.collapsed";
const GROUP_KEY = "deck.activity.groupBy";
// Stacks this long read better as one group than as a run of look-alike rows.
const STACK_MIN = 3;

const load = <T,>(key: string, fallback: T): T => {
  try { return (JSON.parse(localStorage.getItem(key) ?? "null") as T | null) ?? fallback; } catch { return fallback; }
};
const save = (key: string, value: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* a preference only */ }
};

// A ring while checks run, filled once they settle.
const checkDot: Record<string, string> = { SUCCESS: "bg-green", FAILURE: "bg-red", ERROR: "bg-red", PENDING: "border-[1.5px] border-mut" };
const checkWords: Record<string, string> = { SUCCESS: "checks passed", FAILURE: "checks failing", ERROR: "checks errored", PENDING: "checks running", EXPECTED: "checks expected" };
const reviewWords: Record<string, { text: string; tone: string }> = {
  APPROVED: { text: "approved", tone: "text-green" },
  CHANGES_REQUESTED: { text: "requested changes", tone: "text-red" },
  COMMENTED: { text: "commented", tone: "text-body" },
  DISMISSED: { text: "dismissed", tone: "text-dim" },
};

const toIssuePr = (pr: ActivityPr): IssuePr => ({ repo: pr.repo, number: pr.number, title: pr.title, state: pr.state, isDraft: pr.isDraft, url: pr.url, author: pr.author, updatedAt: pr.updatedAt });

const actionPlural: Record<string, [string, string]> = {
  review: ["review", "reviews"], "re-review": ["re-review", "re-reviews"], address: ["review to address", "reviews to address"],
  merge: ["to merge", "to merge"], "fix CI": ["CI to fix", "CI to fix"], "resolve conflicts": ["conflict", "conflicts"],
  "finish draft": ["draft", "drafts"], "answer agent": ["agent waiting", "agents waiting"], "move ticket": ["ticket to move", "tickets to move"],
};

// Fixed columns so keys, statuses and waits line up from row to row; the
// assignee is the first to go when the list is narrow.
const rowGrid = "grid grid-cols-[10px_84px_minmax(0,1fr)_auto_104px_52px] items-center gap-x-3 gap-y-2 @[800px]:grid-cols-[10px_84px_minmax(0,1fr)_auto_104px_104px_52px]";
const assigneeCell = "hidden truncate text-[12px] @[800px]:block";
const checkMark = (pr: ActivityPr) => <span title={checkWords[pr.checks] ?? "no checks"} className={`h-[7px] w-[7px] shrink-0 rounded-full ${checkDot[pr.checks] ?? "bg-edge3"}`} />;
const dotted = (items: ReactNode[]) => items.flatMap((item, i) => (i ? [<span key={`dot${i}`} aria-hidden className="text-dim">·</span>, item] : [item]));

/** The three numbers that answer "who is waiting on whom", each a filter. */
function BallOverview({ summary, stance, person, onStance, onPerson }: {
  summary: BallSummary; stance?: Stance; person?: string;
  onStance: (stance?: Stance) => void; onPerson: (person?: string) => void;
}) {
  const tile = (key: Stance, title: string, count: number, tone: string, detail: ReactNode) => (
    <div role="button" tabIndex={0} aria-pressed={stance === key} onClick={() => { onPerson(undefined); onStance(stance === key ? undefined : key); }}
      onKeyDown={(e) => { if (e.key === "Enter") onStance(stance === key ? undefined : key); }}
      className={`flex min-w-0 cursor-pointer flex-col gap-1.5 px-[18px] py-3.5 ${key !== "you" ? "border-t border-edge @[620px]:border-l @[620px]:border-t-0" : ""} ${stance === key ? "bg-card" : "hover:bg-card/60"}`}>
      <span className="flex items-baseline gap-2.5">
        <span className={`font-mono text-[22px] font-semibold leading-none ${count > 0 ? tone : "text-dim"}`}>{count}</span>
        <span className="text-[13px] font-semibold text-ink">{title}</span>
      </span>
      <span className="flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-mut">{detail}</span>
    </div>
  );
  return (
    <div role="group" aria-label="Whose move summary" className="mb-6 grid overflow-hidden rounded-xl border border-edge bg-panel @[620px]:grid-cols-3">
      {tile("you", "Waiting on you", summary.you, "text-orange",
        summary.yourActions.length ? dotted(summary.yourActions.map(([action, n]) => <span key={action}>{n} {actionPlural[action]?.[n === 1 ? 0 : 1] ?? action}</span>)) : "nothing — you are clear")}
      {tile("them", "You're waiting on", summary.them, "text-blue",
        summary.waitingOn.length ? summary.waitingOn.slice(0, 5).map(([who, n]) => (
          <button key={who} onClick={(e) => { e.stopPropagation(); onStance("them"); onPerson(person === who ? undefined : who); }}
            className={`inline-flex h-5 items-center gap-1 rounded-full border px-2 ${person === who ? "border-blue/60 bg-blue/15 text-blue" : "border-edge2 text-soft hover:border-edge3 hover:text-ink"}`}>
            {who === "reviewers" ? "any reviewer" : who} <span className="font-mono text-mut">{n}</span>
          </button>
        )) : "nobody")}
      {tile("others", "Between others", summary.others, "text-soft",
        summary.othersActions.length ? dotted(summary.othersActions.map(([action, n]) => <span key={action}>{n} {action === "review" ? "open for review" : actionPlural[action]?.[n === 1 ? 0 : 1] ?? action}</span>)) : "—")}
    </div>
  );
}

function Section({ title, count, tone = "text-body", dot, caption, collapsed, onToggle, children }: {
  title: string; count: number; tone?: string; dot?: string; caption?: string; collapsed?: boolean; onToggle?: () => void; children: ReactNode;
}) {
  if (count === 0) return null;
  const label = title.toUpperCase();
  const number = <span className="font-mono font-normal text-mut">{count}</span>;
  if (onToggle && collapsed) return (
    <section aria-label={title} className="mb-2">
      <button onClick={onToggle} aria-expanded={false}
        className={`flex h-10 w-full items-center gap-2 rounded-[10px] border border-edge px-4 text-left text-[11px] font-semibold tracking-[0.06em] hover:border-edge2 hover:bg-panel ${tone}`}>
        <Icon name="chevronRight" size={12} />{label}{number}
      </button>
    </section>
  );
  return (
    <section aria-label={title} className="mb-6">
      <h3 className={`sticky top-0 z-10 flex items-center gap-2 bg-bg px-1 py-2 text-[11px] font-semibold tracking-[0.06em] ${tone}`}>
        {dot && <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />}
        {onToggle
          ? <button onClick={onToggle} aria-expanded className="flex items-center gap-1.5 hover:text-ink"><Icon name="chevronDown" size={12} />{label}</button>
          : label}
        {number}
        {caption && <span className="ml-auto pr-3 font-normal tracking-normal text-mut">{caption}</span>}
      </h3>
      <div className="overflow-hidden rounded-xl border border-edge bg-panel/50">{children}</div>
    </section>
  );
}

export function ActivityView() {
  const { rows, unread, board, activity, loaded } = useActivityRows();
  const inbox = usePrInbox();
  const links = useAgentLinks();
  const settings = useSettings();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>(() => load(GROUP_KEY, "ball"));
  const [stance, setStance] = useState<Stance>();
  const [person, setPerson] = useState<string>();
  const [showDone, setShowDone] = useState(() => load(DONE_KEY, false));
  const [collapsed, setCollapsed] = useState<string[]>(() => load(COLLAPSED_KEY, ["No PR yet"]));
  const [selected, setSelected] = useState<BoardIssue>();
  const [repos, setRepos] = useState<RepoDir[]>([]);
  const [past, setPast] = useState<Record<string, PastSession>>({});
  useEffect(() => { void window.deck.search.listRepos().then(setRepos, () => {}); }, []);
  const [refreshing, setRefreshing] = useState(false);

  const viewer = activity?.viewer ?? "";
  const allPrs = useMemo(() => Object.values(activity?.prs ?? {}), [activity]);
  const requested = useMemo(() => new Set((inbox?.reviewRequested ?? []).map(prKey)), [inbox]);
  const rejectedRe = useMemo(() => {
    try { return new RegExp(settings?.board.rejectedPattern || "reject", "i"); } catch { return /reject/i; }
  }, [settings]);

  const isMine = (row: Row) => row.issue.assigneeId === board?.myAccountId || row.prs.some((pr) => pr.author === viewer);
  const hasAgent = (row: Row) => agentsForTicket(row.issue.key, row.prs, links).length > 0;
  const matching = useMemo(() => {
    const text = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === "mine" && !isMine(row)) return false;
      if (filter === "agents" && !hasAgent(row)) return false;
      if (!text) return true;
      const prText = row.prs.map((pr) => `${pr.repo} #${pr.number} ${pr.title} ${pr.author}`).join(" ");
      return `${row.issue.key} ${row.issue.summary} ${row.issue.assignee ?? ""} ${row.issue.statusName} ${prText}`.toLowerCase().includes(text);
    });
  }, [rows, query, filter, board, viewer, links]);

  const balls = useMemo(() => new Map(matching.map((row) => [row.issue.key, rowBall(row, viewer, requested, links, board?.myAccountId)])), [matching, viewer, requested, links, board]);
  // Waiting agents no ticket accounts for, listed and counted with the rest of the user's moves.
  const loose = useMemo(() => {
    const text = query.trim().toLowerCase();
    return looseWaitingAgents(rows, links).filter((link) => !text || `${link.title ?? ""} ${link.cwd} ${link.agent}`.toLowerCase().includes(text));
  }, [rows, links, query]);
  const summary = useMemo(() => summarizeBalls([...matching.filter(rowActive).map((row) => balls.get(row.issue.key)), ...loose.map(agentBall)]), [matching, balls, loose]);
  // Within a ball section: new first, then whoever has waited longest.
  const byWait = (a: Row, b: Row) => Number(b.changes.length > 0) - Number(a.changes.length > 0)
    || (balls.get(a.issue.key)?.since ?? "").localeCompare(balls.get(b.issue.key)?.since ?? "");
  const ballSections = useMemo(() => {
    const live = matching.filter(rowActive);
    const of = (key: Stance) => live
      .filter((row) => balls.get(row.issue.key)?.stance === key)
      .filter((row) => !person || (balls.get(row.issue.key)?.who.length ? balls.get(row.issue.key)!.who.includes(person) : person === "reviewers"))
      .sort(byWait);
    return {
      you: of("you"),
      them: of("them"),
      others: of("others"),
      noPr: live.filter((row) => !balls.get(row.issue.key)),
      done: matching.filter((row) => !rowActive(row)),
    };
  }, [matching, balls, person]);
  const othersGroups = useMemo(() => groupStacks(ballSections.others, allPrs), [ballSections.others, allPrs]);

  // Finished sessions to resume, looked up only for what waits on the user
  // with no live agent on it.
  const pastWanted = useMemo(() => [...balls.values()]
    .filter((ball) => ball?.stance === "you" && ball.pr && !ball.agent && agentsForPr(ball.pr, undefined, links).length === 0)
    .map((ball) => prKey(ball!.pr!)).sort().join(" "), [balls, links]);
  useEffect(() => {
    if (!pastWanted) return;
    let cancelled = false;
    const timer = setTimeout(() => void window.deck.agents.past(pastWanted.split(" ")).then((found) => { if (!cancelled) setPast(found); }, () => {}), 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pastWanted]);
  const showBall = (key: Stance) => !stance || stance === key;

  // Each row lands in the first section it qualifies for.
  const sections = useMemo(() => {
    const fresh = matching.filter((row) => row.changes.length > 0);
    const quiet = matching.filter((row) => row.changes.length === 0);
    const flagged = quiet.filter((row) => row.flags.length > 0);
    const calm = quiet.filter((row) => row.flags.length === 0);
    const live = (row: Row) => row.prs.some((pr) => pr.state === "OPEN");
    return {
      fresh,
      flagged,
      inFlight: calm.filter((row) => !row.done && live(row)),
      noPr: calm.filter((row) => !row.done && !live(row)),
      done: calm.filter((row) => row.done),
    };
  }, [matching]);

  const inFlightGroups = useMemo(() => groupStacks(sections.inFlight, allPrs), [sections.inFlight, allPrs]);

  const toggle = (title: string) => setCollapsed((prev) => {
    const next = prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title];
    save(COLLAPSED_KEY, next);
    return next;
  });
  const openRow = (row: Row) => {
    if (row.changes.length > 0) void window.deck.activity.markSeen({ tickets: [row.issue.key] });
    setSelected(row.issue);
  };
  // PRs open on the reviews page, the one PR screen; back returns here.
  const openPr = (row: Row, pr: ActivityPr) => {
    void window.deck.activity.markSeen({ prs: [prKey(pr)] });
    openPullRequest({ ...toIssuePr(pr), issueKey: row.issue.key });
  };
  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([window.deck.board.sync().catch(() => undefined), window.deck.activity.refresh()]);
    setRefreshing(false);
  };
  const markAll = () => void window.deck.activity.markSeen({ tickets: rows.filter((row) => row.changes.length > 0).map((row) => row.issue.key) });

  const defaultAgent: Agent = settings?.defaultAgent ?? "claude";
  const rowProps = { viewer, requested, allPrs, links, past, repos, defaultAgent, selectedKey: selected?.key, onOpen: openRow, onOpenPr: openPr };
  const counts: Record<Filter, number> = { all: rows.length, mine: rows.filter(isMine).length, agents: rows.filter(hasAgent).length };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Activity"
        sub={!loaded ? "waiting for the board and GitHub…" : unread > 0 ? <span><span className="font-semibold text-ink">{unread} new</span> since you looked</span> : "nothing new since you looked"}>
        {activity && <span title="When GitHub was last asked" className="mr-1.5 font-mono text-[11px] text-mut">PRs {relativeTime(new Date(activity.at).toISOString())}</span>}
        <HeaderButton disabled={unread === 0} onClick={markAll}>Mark all seen</HeaderButton>
        <HeaderButton onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "↻ Refresh"}</HeaderButton>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2.5 border-b border-edge px-6 py-2.5 text-[12px]">
        <div role="group" aria-label="Show" className="flex rounded-lg border border-edge bg-panel p-0.5">
          {(["all", "mine", "agents"] as const).filter((f) => f !== "mine" || board?.myAccountId || viewer).map((f) => (
            <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
              className={`flex h-[26px] items-center gap-1.5 rounded-md px-2.5 ${filter === f ? "bg-card2 font-medium text-ink" : "text-body hover:text-ink"}`}>
              {f === "all" ? "All" : f === "mine" ? "Mine" : "With agent"}<span className="font-mono font-normal text-mut">{counts[f]}</span>
            </button>
          ))}
        </div>
        <label className="flex h-[30px] w-[240px] items-center gap-2 rounded-lg border border-edge bg-panel px-2.5 text-mut focus-within:border-accent/60">
          <Icon name="search" size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter tickets and PRs" aria-label="Filter tickets and pull requests"
            className="min-w-0 flex-1 bg-transparent text-soft placeholder:text-mut focus:outline-none" />
        </label>
        <div role="group" aria-label="Group by" className="ml-auto flex rounded-lg border border-edge bg-panel p-0.5">
          {(["ball", "news"] as const).map((g) => (
            <button key={g} onClick={() => { setGroupBy(g); save(GROUP_KEY, g); }} aria-pressed={groupBy === g}
              className={`h-[26px] rounded-md px-2.5 ${groupBy === g ? "bg-card2 font-medium text-ink" : "text-body hover:text-ink"}`}>{g === "ball" ? "Whose move" : "What's new"}</button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-body hover:text-ink">
          <input type="checkbox" checked={showDone} onChange={(e) => { setShowDone(e.target.checked); save(DONE_KEY, e.target.checked); }} className="m-0 accent-[var(--color-accent)]" />
          Show done
        </label>
      </div>
      <div className="flex min-h-0 flex-1">
        <div aria-label="Ticket activity" className="min-h-0 min-w-0 flex-1 overflow-y-auto text-[13px]">
          <div className="@container mx-auto w-full max-w-[1120px] px-6 pb-10 pt-5">
            {loaded && <BallOverview summary={summary} stance={stance} person={person}
              onStance={(next) => { setStance(next); if (next && groupBy !== "ball") { setGroupBy("ball"); save(GROUP_KEY, "ball"); } }} onPerson={setPerson} />}
            {(stance || person) && (
              <div className="-mt-3 mb-4 flex items-center gap-2 text-[12px] text-mut">
                showing {stance === "you" ? "what waits on you" : stance === "them" ? `what you are waiting on${person ? ` from ${person === "reviewers" ? "any reviewer" : person}` : ""}` : "what is between others"}
                <button onClick={() => { setStance(undefined); setPerson(undefined); }} className="rounded-md border border-edge2 px-2 text-soft hover:border-edge3 hover:text-ink">clear ×</button>
              </div>
            )}
            {groupBy === "ball" ? <>
            {showBall("you") && <Section title="Waiting on you" count={ballSections.you.length + loose.length} tone="text-orange" dot="bg-orange" caption="waiting">
              {loose.map((link) => <AgentRow key={link.sessionId} link={link} />)}
              {ballSections.you.map((row) => <TicketRow key={row.issue.key} row={row} ball={balls.get(row.issue.key)} {...rowProps} />)}
            </Section>}
            {showBall("them") && <Section title="You're waiting on" count={ballSections.them.length} tone="text-blue" dot="bg-blue">
              {ballSections.them.map((row) => <TicketRow key={row.issue.key} row={row} ball={balls.get(row.issue.key)} {...rowProps} />)}
            </Section>}
            {showBall("others") && <Section title="Between others" count={ballSections.others.length} collapsed={collapsed.includes("Between others")} onToggle={() => toggle("Between others")}>
              {othersGroups.map((group) => group.stack
                ? <StackGroup key={group.key} rows={group.rows} base={group.base} {...rowProps} />
                : <TicketRow key={group.key} row={group.rows[0]} ball={balls.get(group.rows[0].issue.key)} {...rowProps} />)}
            </Section>}
            {!stance && <Section title="No PR yet" count={ballSections.noPr.length} collapsed={collapsed.includes("No PR yet")} onToggle={() => toggle("No PR yet")}>
              {ballSections.noPr.map((row) => <TicketRow key={row.issue.key} row={row} compact {...rowProps} />)}
            </Section>}
            {!stance && showDone && (
              <Section title="Done" count={ballSections.done.length} collapsed={collapsed.includes("Done")} onToggle={() => toggle("Done")}>
                {ballSections.done.map((row) => <TicketRow key={row.issue.key} row={row} compact {...rowProps} />)}
              </Section>
            )}
            </> : <>
            <Section title="New since you looked" count={sections.fresh.length} tone="text-ink" dot="bg-ink">
              {sections.fresh.map((row) => <TicketRow key={row.issue.key} row={row} ball={balls.get(row.issue.key)} {...rowProps} />)}
            </Section>
            <Section title="Needs a look" count={sections.flagged.length} tone="text-red" dot="bg-red">
              {sections.flagged.map((row) => <TicketRow key={row.issue.key} row={row} ball={balls.get(row.issue.key)} {...rowProps} />)}
            </Section>
            <Section title="In flight" count={sections.inFlight.length}>
              {inFlightGroups.map((group) => group.stack
                ? <StackGroup key={group.key} rows={group.rows} base={group.base} {...rowProps} />
                : <TicketRow key={group.key} row={group.rows[0]} ball={balls.get(group.rows[0].issue.key)} {...rowProps} />)}
            </Section>
            <Section title="No PR yet" count={sections.noPr.length} collapsed={collapsed.includes("No PR yet")} onToggle={() => toggle("No PR yet")}>
              {sections.noPr.map((row) => <TicketRow key={row.issue.key} row={row} compact {...rowProps} />)}
            </Section>
            {showDone && (
              <Section title="Done" count={sections.done.length} collapsed={collapsed.includes("Done")} onToggle={() => toggle("Done")}>
                {sections.done.map((row) => <TicketRow key={row.issue.key} row={row} compact {...rowProps} />)}
              </Section>
            )}
            </>}
            {loaded && matching.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-16 text-mut">
                <Icon name="check" size={20} />
                {rows.length === 0 ? "No tickets on the board." : "Nothing matches."}
              </div>
            )}
            {!loaded && <p className="py-8 text-mut">Waiting for the board and GitHub… Connect a board under Settings → Workspaces if nothing shows up.</p>}
          </div>
        </div>
        {selected && settings && (
          <IssuePanel issue={selected} rejected={rejectedRe.test(selected.statusName)} onClose={() => setSelected(undefined)} onOpenDiff={(pr) => openPullRequest({ ...pr, issueKey: selected.key })} />
        )}
      </div>
    </div>
  );
}

interface RowProps {
  viewer: string;
  requested: Set<string>;
  allPrs: ActivityPr[];
  links: AgentLink[];
  past: Record<string, PastSession>;
  repos: RepoDir[];
  defaultAgent: Agent;
  selectedKey?: string;
  onOpen: (row: Row) => void;
  onOpenPr: (row: Row, pr: ActivityPr) => void;
}

/** An agent waiting on the user with no ticket of its own, so whose move it is covers every agent. */
function AgentRow({ link }: { link: AgentLink }) {
  const name = agentLabels[link.agent];
  const next: Continuation = {
    kind: "live", agent: { link, reason: "ticket" }, label: `Answer ${name}`,
    hint: `${link.title ?? name} · ${statusLabels[link.status].toLowerCase()}\nOpens its terminal`, run: () => focusTerminal(link.termId),
  };
  const since = new Date(link.updatedAt).toISOString();
  return (
    <article onClick={next.run} aria-label={link.title ?? name} className={`${rowGrid} cursor-pointer border-b border-edge/60 px-4 py-3 last:border-b-0 hover:bg-card`}>
      <span className={`flex justify-center ${statusTones[link.status].text}`}><StatusMark status={link.status} size={9} /></span>
      <span className={`truncate font-mono text-[12px] ${statusTones[link.status].text}`}>{name}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium text-ink" title={link.title ?? undefined}>{link.title ?? link.cwd.split("/").pop()}</span>
        <span className="line-clamp-2 text-[12px] text-mut">{link.reviewNote ?? `${statusLabels[link.status]} · no ticket`}</span>
      </span>
      <span className="flex items-center"><ContinueButton next={next} /></span>
      <span className={`${assigneeCell} font-mono text-mut`}>{link.cwd.split("/").pop()}</span>
      <span />
      <span className="justify-self-end whitespace-nowrap font-mono text-[12px] text-orange" title={`${statusLabels[link.status]} since ${new Date(since).toLocaleString()}`}>{relativeTime(since).replace(" ago", "")}</span>
    </article>
  );
}

function TicketRow({ row, compact = false, ball, viewer, requested, allPrs, links, past, repos, defaultAgent, selectedKey, onOpen, onOpenPr }: RowProps & { row: Row; compact?: boolean; ball?: RowBall }) {
  const isNew = row.changes.length > 0;
  const agents = agentsForTicket(row.issue.key, row.prs, links);
  const pr = ball?.pr;
  const next = ball?.stance === "you" ? continuation({
    pr,
    action: ball.action,
    ticket: { key: row.issue.key, url: row.issue.url },
    agents: pr ? agentsForPr(pr, row.issue.key, links) : agents,
    waitingAgent: ball.agent,
    past: pr ? past[prKey(pr)] : undefined,
    cwd: pr ? repos.find((repo) => repo.name === pr.repo.split("/")[1])?.path : undefined,
    agent: defaultAgent,
    onOpenPr: () => pr && onOpenPr(row, pr),
  }) : undefined;

  return (
    <article onClick={() => onOpen(row)} aria-label={row.issue.key}
      className={`${rowGrid} cursor-pointer border-b border-edge/60 px-4 last:border-b-0 hover:bg-card ${compact ? "py-2" : "py-3"} ${selectedKey === row.issue.key ? "bg-card" : isNew ? "bg-panel" : ""}`}>
      <span className="flex justify-center">{isNew && <span aria-label="New since you last looked" className="h-2 w-2 rounded-full bg-ink" />}</span>
      <button onClick={(e) => { e.stopPropagation(); window.open(row.issue.url); }} title={`Open ${row.issue.key} in the tracker`}
        className={`max-w-full justify-self-start truncate font-mono text-[12px] hover:underline ${isNew ? "font-semibold text-ink" : "text-body"}`}>{row.issue.key}</button>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={`truncate text-[13px] text-ink ${isNew ? "font-semibold" : "font-medium"}`} title={row.issue.summary}>{row.issue.summary}</span>
        {isNew && <span className="text-[12px] text-soft">{row.changes.join(" · ")}</span>}
      </span>
      <span className="flex items-center gap-1.5">
        {next && <ContinueButton next={next} />}
        {/* The agent Continue goes to is already on the button. */}
        {agents.filter((agent) => agent.link.sessionId !== next?.agent?.link.sessionId).slice(0, 2).map((agent) => <AgentChip key={agent.link.sessionId} agent={agent} />)}
        {agents.length > 3 && <span className="shrink-0 font-mono text-[11px] text-mut">+{agents.length - 3}</span>}
      </span>
      <span className={`${assigneeCell} text-body`}>{row.issue.assignee ?? "unassigned"}</span>
      <span className="max-w-full justify-self-start truncate rounded-md border border-edge2 px-2 text-[12px] leading-5 text-soft" title={row.column !== row.issue.statusName ? `${row.issue.statusName} (${row.column})` : row.issue.statusName}>{row.issue.statusName}</span>
      {ball && ball.stance !== "done"
        ? <span className={`justify-self-end whitespace-nowrap font-mono text-[12px] ${ball.stance === "you" ? "text-orange" : ball.stance === "them" ? "text-blue" : "text-mut"}`}
            title={`${ballText(ball)} since ${new Date(ball.since).toLocaleString()}`}>{relativeTime(ball.since).replace(" ago", "")}</span>
        : <span className="justify-self-end whitespace-nowrap font-mono text-[12px] text-mut" title="Last activity">{relativeTime(row.lastActivity || row.issue.updated).replace(" ago", "")}</span>}
      {row.flags.map((flag) => <p key={flag} className="col-[2/-1] flex items-center gap-1.5 text-[12px] text-red"><span aria-hidden>⚠</span>{flag}</p>)}
      {!compact && row.prs.length > 0 && (
        <div className="col-[2/-1] flex flex-col gap-1.5">
          {row.prs.map((pr) => <PrLine key={prKey(pr)} pr={pr} viewer={viewer} below={stackedOn(pr, allPrs)} move={moveOf(pr, viewer, requested)} onOpen={() => onOpenPr(row, pr)} />)}
        </div>
      )}
    </article>
  );
}

/** One PR: which it is, whose move, then who last committed and reviewed.
 *  Fixed first columns so the PR lines of a list align; the rest moves below
 *  them when the list is narrow. */
function PrLine({ pr, viewer, below, move, onOpen }: { pr: ActivityPr; viewer: string; below?: ActivityPr; move: Move; onOpen: () => void }) {
  const review = pr.lastReview && (reviewWords[pr.lastReview.state] ?? { text: pr.lastReview.state.toLowerCase(), tone: "text-body" });
  const who = (login: string) => (login === viewer ? "you" : login || "?");
  const details = [
    pr.mergeable === "CONFLICTING" && pr.state === "OPEN" && <span key="conflicts" className="text-red" title="Merge conflicts">conflicts</span>,
    pr.lastCommit && <span key="commit" title={pr.lastCommit.at}>pushed by <span className="text-soft">{who(pr.lastCommit.author)}</span> {relativeTime(pr.lastCommit.at)}</span>,
    pr.lastReview && review
      ? <span key="review" title={pr.lastReview.onHead ? "On the latest commit" : "On an older commit"}>
          <span className="text-soft">{who(pr.lastReview.author)}</span> <span className={review.tone}>{review.text}</span> {relativeTime(pr.lastReview.at)}
          {!pr.lastReview.onHead && pr.state === "OPEN" && <span> · before the last push</span>}
        </span>
      : pr.state === "OPEN" && <span key="review">no reviews yet</span>,
    // Open threads are the user's to answer only when the move is theirs.
    pr.unresolvedThreads > 0 && <span key="threads" className={move.strong ? "text-orange" : "text-soft"}>{pr.unresolvedThreads} open thread{pr.unresolvedThreads === 1 ? "" : "s"}</span>,
  ].filter(Boolean);
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-[12px] @[640px]:grid-cols-[120px_240px_minmax(0,1fr)]">
      <span className="flex min-w-0 items-center gap-[7px]">
        {checkMark(pr)}
        <button onClick={(e) => { e.stopPropagation(); onOpen(); }} title={`${pr.title}\n${prKey(pr)}`} className="min-w-0 truncate font-mono text-soft hover:text-ink hover:underline">
          <span className="text-body">{pr.repo.split("/")[1]}</span>#{pr.number}
        </button>
        {below && <span className="shrink-0 font-mono text-mut" title={`Stacked on ${prKey(below)} (${below.headRefName})`}>on #{below.number}</span>}
      </span>
      <span className="flex min-w-0"><MovePill move={move} /></span>
      <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-mut @[640px]:col-span-1">{dotted(details)}</span>
    </div>
  );
}

interface Group { key: string; rows: Row[]; stack: boolean; base?: ActivityPr; lastActivity: string }

/** Tickets whose PRs build on one another, gathered under the PR at the bottom
 *  of the stack; short stacks and lone PRs stay plain rows. */
function groupStacks(rows: Row[], all: ActivityPr[]): Group[] {
  const rootOf = (pr: ActivityPr): ActivityPr => {
    const seen = new Set<string>();
    let current = pr;
    for (let below = stackedOn(current, all); below && !seen.has(prKey(below)); below = stackedOn(current, all)) {
      seen.add(prKey(current));
      current = below;
    }
    return current;
  };
  const byRoot = new Map<string, { base: ActivityPr; rows: Row[] }>();
  for (const row of rows) {
    const open = row.prs.find((pr) => pr.state === "OPEN");
    const base = open ? rootOf(open) : undefined;
    const key = base ? prKey(base) : row.issue.key;
    const group = byRoot.get(key) ?? { base: base!, rows: [] };
    group.rows.push(row);
    byRoot.set(key, group);
  }
  const groups: Group[] = [];
  for (const [key, { base, rows: members }] of byRoot) {
    const lastActivity = members.reduce((latest, row) => (row.lastActivity > latest ? row.lastActivity : latest), "");
    if (members.length >= STACK_MIN) groups.push({ key: `stack:${key}`, rows: members, stack: true, base, lastActivity });
    else for (const row of members) groups.push({ key: row.issue.key, rows: [row], stack: false, lastActivity: row.lastActivity });
  }
  return groups.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

/** A stack as one block: a header naming it, then one line per ticket with
 *  its PR and whose move it is. */
function StackGroup({ rows, base, viewer, requested, allPrs, links, selectedKey, onOpen, onOpenPr }: RowProps & { rows: Row[]; base?: ActivityPr }) {
  const [open, setOpen] = useState(false);
  const moves = rows.map((row) => row.prs.find((pr) => pr.state === "OPEN")).filter((pr): pr is ActivityPr => Boolean(pr)).map((pr) => moveOf(pr, viewer, requested).label);
  const summary = [...new Set(moves)].map((label) => `${moves.filter((m) => m === label).length} ${label.toLowerCase()}`).join(" · ");
  return (
    <div className="border-b border-edge/60 last:border-b-0">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`${rowGrid} w-full px-4 py-3 text-left hover:bg-card`}>
        <span className="flex justify-center text-mut"><Icon name={open ? "chevronDown" : "chevronRight"} size={12} /></span>
        <span className="col-[2/5] flex min-w-0 items-center gap-2">
          <Icon name="layers" size={13} className="text-mut" />
          <span className="shrink-0 text-[13px] font-medium text-ink">Stack of {rows.length}</span>
          <span className="min-w-0 truncate text-[12px] text-mut">
            {base && <>in {base.repo.split("/")[1]}, starting at <span className="font-mono">#{base.number}</span> into <span className="font-mono">{base.baseRefName}</span></>}
          </span>
        </span>
        <span className="col-[5/-1] truncate text-right text-[12px] text-mut" title={summary}>{summary}</span>
      </button>
      {open && (
        <div className="border-t border-edge/60 bg-panel">
          {rows.map((row) => {
            const pr = row.prs.find((p) => p.state === "OPEN")!;
            return (
              <div key={row.issue.key} onClick={() => onOpen(row)} role="button"
                className={`${rowGrid} cursor-pointer border-b border-edge/60 px-4 py-2 last:border-b-0 hover:bg-card ${selectedKey === row.issue.key ? "bg-card" : ""}`}>
                <span className="flex justify-center">{checkMark(pr)}</span>
                <span className="truncate font-mono text-[12px] text-body">{row.issue.key}</span>
                <span className="truncate text-[13px] text-soft" title={row.issue.summary}>{row.issue.summary}</span>
                <span className="flex items-center gap-2 text-[12px]">
                  <button onClick={(e) => { e.stopPropagation(); onOpenPr(row, pr); }} className="shrink-0 font-mono text-soft hover:text-ink hover:underline">#{pr.number}</button>
                  {stackedOn(pr, allPrs) && <span className="shrink-0 font-mono text-mut">on #{stackedOn(pr, allPrs)!.number}</span>}
                  {agentsForPr(pr, row.issue.key, links).slice(0, 1).map((agent) => <AgentChip key={agent.link.sessionId} agent={agent} />)}
                </span>
                <span className="col-[5/-1] flex min-w-0"><MovePill move={moveOf(pr, viewer, requested)} /></span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
