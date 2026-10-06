import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { IssuePr } from "../../../main/github.js";
import type { BoardIssue } from "../../../main/board/types.js";
import { ballFrom, ballText, stackedOn, summarizeBalls, ticketBall, type ActivityPr, type ActivityRow, type BallState, type BallSummary, type Stance } from "../../../shared/activity.js";
import { agentsForPr, agentsForTicket, needsYou, type AgentLink, type LinkedAgent, type PastSession } from "../../../shared/agentLinks.js";
import type { Agent } from "../../../shared/agents.js";
import type { RepoDir } from "../../../main/providers.js";
import { prKey } from "../../../shared/prs.js";
import { useActivityRows } from "../lib/useActivity.js";
import { useAgentLinks } from "../lib/useAgentLinks.js";
import { AgentChip, ContinueButton, continuation } from "./AgentLinks.js";
import { usePrInbox } from "../lib/useInbox.js";
import { useSettings } from "../lib/useSettings.js";
import { Icon } from "./icons.js";
import { IssuePanel } from "./IssuePanel.js";
import { PrScreen } from "./PrScreen.js";
import { relativeTime } from "./prUi.js";

// Every board ticket with its PRs, grouped by whose move it is (waiting on
// the user, the user waiting on someone, or between others) or by what
// changed since the user last looked. Each PR says whose move it is in words.

type Row = ActivityRow<BoardIssue>;
type Filter = "all" | "new" | "mine" | "agents";
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

const checkTone: Record<string, string> = { SUCCESS: "text-green", FAILURE: "text-red", ERROR: "text-red", PENDING: "text-orange" };
const checkWords: Record<string, string> = { SUCCESS: "checks passed", FAILURE: "checks failing", ERROR: "checks errored", PENDING: "checks running", EXPECTED: "checks expected" };
const reviewWords: Record<string, { text: string; tone: string }> = {
  APPROVED: { text: "approved", tone: "text-green" },
  CHANGES_REQUESTED: { text: "requested changes", tone: "text-red" },
  COMMENTED: { text: "commented", tone: "text-body" },
  DISMISSED: { text: "dismissed", tone: "text-dim" },
};

const toIssuePr = (pr: ActivityPr): IssuePr => ({ repo: pr.repo, number: pr.number, title: pr.title, state: pr.state, isDraft: pr.isDraft, url: pr.url, author: pr.author, updatedAt: pr.updatedAt });

interface Move { label: string; tone: string; strong?: boolean; hint: string }

const tones = {
  blue: "bg-blue/10 text-blue",
  orange: "bg-orange/10 text-orange",
  green: "bg-green/10 text-green",
  accent: "bg-accent/10 text-accent",
  dim: "bg-card2 text-mut",
};

const stanceTone: Record<Stance, string> = { you: tones.orange, them: tones.blue, others: tones.dim, done: tones.accent };

/** Whose move it is on one PR, from the user's side of it. */
function moveOf(pr: ActivityPr, viewer: string, requested: Set<string>): Move & { state: BallState } {
  const state = ballFrom(pr, viewer, requested.has(prKey(pr)));
  const since = `since ${relativeTime(state.since)}`;
  if (pr.state === "MERGED") return { state, label: "Merged", tone: tones.accent, hint: pr.mergedAt ? `Merged ${relativeTime(pr.mergedAt)}` : "Merged" };
  if (pr.state === "CLOSED") return { state, label: "Closed", tone: tones.dim, hint: "Closed without merging" };
  const label = ballText(state);
  const tone = state.stance === "you" && state.action === "merge" ? tones.green : stanceTone[state.stance];
  return { state, label, tone, strong: state.stance === "you", hint: `${label} · ${since}` };
}

/** A ticket's ball, with the PR it is on and the agent waiting on the user when that is it. */
type RowBall = BallState & { pr?: ActivityPr; agent?: LinkedAgent };

/** One ball per ticket, from its open PRs and any agent of it waiting on the
 *  user; merged work on a ticket that has not moved is its assignee's move. */
function rowBall(row: Row, viewer: string, requested: Set<string>, links: AgentLink[], myAccountId?: string): RowBall | undefined {
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

const actionPlural: Record<string, [string, string]> = {
  review: ["review", "reviews"], "re-review": ["re-review", "re-reviews"], address: ["review to address", "reviews to address"],
  merge: ["to merge", "to merge"], "fix CI": ["CI to fix", "CI to fix"], "resolve conflicts": ["conflict", "conflicts"],
  "finish draft": ["draft", "drafts"], "answer agent": ["agent waiting", "agents waiting"], "move ticket": ["ticket to move", "tickets to move"],
};

/** The three numbers that answer "who is waiting on whom", each a filter. */
function BallOverview({ summary, stance, person, onStance, onPerson }: {
  summary: BallSummary; stance?: Stance; person?: string;
  onStance: (stance?: Stance) => void; onPerson: (person?: string) => void;
}) {
  const tile = (key: Stance, title: string, count: number, tone: string, detail: ReactNode) => (
    <div role="button" tabIndex={0} aria-pressed={stance === key} onClick={() => { onPerson(undefined); onStance(stance === key ? undefined : key); }}
      onKeyDown={(e) => { if (e.key === "Enter") onStance(stance === key ? undefined : key); }}
      className={`flex min-w-[220px] flex-1 cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 ${stance === key ? "border-accent/60 bg-card" : "border-edge hover:border-edge2 hover:bg-card"}`}>
      <span className="flex items-baseline gap-2">
        <span className={`text-[20px] font-bold leading-none ${count > 0 ? tone : "text-dim"}`}>{count}</span>
        <span className="text-[10px] tracking-widest text-dim">{title.toUpperCase()}</span>
      </span>
      <span className="flex min-h-[18px] flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-mut">{detail}</span>
    </div>
  );
  return (
    <div className="mb-5 flex flex-wrap gap-3">
      {tile("you", "Waiting on you", summary.you, "text-orange",
        summary.yourActions.length ? summary.yourActions.map(([action, n]) => <span key={action}>{n} {actionPlural[action]?.[n === 1 ? 0 : 1] ?? action}</span>) : "nothing — you are clear")}
      {tile("them", "You're waiting on", summary.them, "text-blue",
        summary.waitingOn.length ? summary.waitingOn.slice(0, 5).map(([who, n]) => (
          <button key={who} onClick={(e) => { e.stopPropagation(); onStance("them"); onPerson(person === who ? undefined : who); }}
            className={`rounded-full border px-1.5 leading-[16px] ${person === who ? "border-blue/60 bg-blue/10 text-blue" : "border-edge2 hover:border-edge3 hover:text-ink"}`}>
            {who === "reviewers" ? "any reviewer" : who} <span className="text-dim">{n}</span>
          </button>
        )) : "nobody")}
      {tile("others", "Between others", summary.others, "text-soft",
        summary.othersActions.length ? summary.othersActions.map(([action, n]) => <span key={action}>{n} {action === "review" ? "open for review" : actionPlural[action]?.[n === 1 ? 0 : 1] ?? action}</span>) : "—")}
    </div>
  );
}

function MovePill({ move }: { move: Move }) {
  return <span title={move.hint} className={`inline-flex h-[18px] max-w-full shrink-0 items-center truncate rounded-full px-2 text-[10px] ${move.tone} ${move.strong ? "font-bold" : ""}`}>{move.label}</span>;
}

function Section({ title, count, tone = "text-dim", collapsed, onToggle, children }: {
  title: string; count: number; tone?: string; collapsed?: boolean; onToggle?: () => void; children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section aria-label={title} className="mb-6">
      <h3 className={`sticky top-0 z-10 flex items-center gap-2 bg-bg py-2 text-[10px] tracking-widest ${tone}`}>
        {onToggle
          ? <button onClick={onToggle} className="flex items-center gap-1.5 hover:text-ink"><Icon name={collapsed ? "chevronRight" : "chevronDown"} size={10} />{title.toUpperCase()}</button>
          : title.toUpperCase()}
        <span className="text-mut">{count}</span>
      </h3>
      {!collapsed && <div className="overflow-hidden rounded-lg border border-edge">{children}</div>}
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
  const [diffPr, setDiffPr] = useState<IssuePr>();
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
      if (filter === "new" && row.changes.length === 0) return false;
      if (filter === "mine" && !isMine(row)) return false;
      if (filter === "agents" && !hasAgent(row)) return false;
      if (!text) return true;
      const prText = row.prs.map((pr) => `${pr.repo} #${pr.number} ${pr.title} ${pr.author}`).join(" ");
      return `${row.issue.key} ${row.issue.summary} ${row.issue.assignee ?? ""} ${row.issue.statusName} ${prText}`.toLowerCase().includes(text);
    });
  }, [rows, query, filter, board, viewer, links]);

  const balls = useMemo(() => new Map(matching.map((row) => [row.issue.key, rowBall(row, viewer, requested, links, board?.myAccountId)])), [matching, viewer, requested, links, board]);
  // A done ticket with a PR still open is not done for whoever holds that PR.
  const active = (row: Row) => !row.done || row.prs.some((pr) => pr.state === "OPEN");
  const summary = useMemo(() => summarizeBalls(matching.filter(active).map((row) => balls.get(row.issue.key))), [matching, balls]);
  // Within a ball section: new first, then whoever has waited longest.
  const byWait = (a: Row, b: Row) => Number(b.changes.length > 0) - Number(a.changes.length > 0)
    || (balls.get(a.issue.key)?.since ?? "").localeCompare(balls.get(b.issue.key)?.since ?? "");
  const ballSections = useMemo(() => {
    const live = matching.filter(active);
    const of = (key: Stance) => live
      .filter((row) => balls.get(row.issue.key)?.stance === key)
      .filter((row) => !person || (balls.get(row.issue.key)?.who.length ? balls.get(row.issue.key)!.who.includes(person) : person === "reviewers"))
      .sort(byWait);
    return {
      you: of("you"),
      them: of("them"),
      others: of("others"),
      noPr: live.filter((row) => !balls.get(row.issue.key)),
      done: matching.filter((row) => !active(row)),
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
  const openPr = (row: Row, pr: ActivityPr) => {
    void window.deck.activity.markSeen({ prs: [prKey(pr)] });
    setSelected(row.issue);
    setDiffPr(toIssuePr(pr));
  };
  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([window.deck.board.sync().catch(() => undefined), window.deck.activity.refresh()]);
    setRefreshing(false);
  };
  const markAll = () => void window.deck.activity.markSeen({ tickets: rows.filter((row) => row.changes.length > 0).map((row) => row.issue.key) });

  const defaultAgent: Agent = settings?.defaultAgent ?? "claude";
  const rowProps = { viewer, requested, allPrs, links, past, repos, defaultAgent, selectedKey: selected?.key, onOpen: openRow, onOpenPr: openPr };
  const counts: Record<Filter, number> = { all: rows.length, new: unread, mine: rows.filter(isMine).length, agents: rows.filter(hasAgent).length };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge px-6 py-3">
        <span className="font-bold text-ink">Activity</span>
        <span className="text-[11px] text-dim">
          {!loaded ? "waiting for the board and GitHub…" : unread > 0 ? <><span className="text-accent">{unread} new</span> since you last looked</> : "nothing new since you last looked"}
        </span>
        <span className="ml-auto flex items-center gap-4 text-[11px] text-dim">
          {activity && <span title="When GitHub was last asked">PRs {relativeTime(new Date(activity.at).toISOString())}</span>}
          <button disabled={unread === 0} onClick={markAll} className="hover:text-ink disabled:opacity-30">mark all seen</button>
          <button onClick={() => void refresh()} className="hover:text-ink">{refreshing ? "refreshing…" : "↻ refresh"}</button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-6 py-2 font-sans text-[11px]">
        <div role="group" aria-label="Show" className="flex rounded-md border border-edge2 p-0.5">
          {(["all", "new", "mine", "agents"] as const).filter((f) => f !== "mine" || board?.myAccountId || viewer).map((f) => (
            <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
              className={`flex items-center gap-1.5 rounded px-2.5 py-0.5 ${filter === f ? "bg-card2 text-ink" : "text-dim hover:text-ink"}`}>
              {f === "all" ? "All" : f === "new" ? "New" : f === "mine" ? "Mine" : "With agent"}<span className={f === "new" && counts.new > 0 ? "text-accent" : "text-mut"}>{counts[f]}</span>
            </button>
          ))}
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter tickets and PRs" aria-label="Filter tickets and pull requests"
          className="w-[220px] rounded-md border border-edge2 bg-card px-2 py-1 text-body placeholder:text-dim focus:border-accent focus:outline-none" />
        <div role="group" aria-label="Group by" className="ml-auto flex items-center gap-1.5 text-dim">
          group by
          <div className="flex rounded-md border border-edge2 p-0.5">
            {(["ball", "news"] as const).map((g) => (
              <button key={g} onClick={() => { setGroupBy(g); save(GROUP_KEY, g); }} aria-pressed={groupBy === g}
                className={`rounded px-2.5 py-0.5 ${groupBy === g ? "bg-card2 text-ink" : "hover:text-ink"}`}>{g === "ball" ? "whose move" : "what's new"}</button>
            ))}
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-dim hover:text-ink">
          <input type="checkbox" checked={showDone} onChange={(e) => { setShowDone(e.target.checked); save(DONE_KEY, e.target.checked); }} className="accent-[var(--color-accent)]" />
          show done
        </label>
      </div>
      <div className="flex min-h-0 flex-1">
        <div aria-label="Ticket activity" className="min-h-0 min-w-0 flex-1 overflow-y-auto font-sans text-[12px]">
          <div className="@container mx-auto w-full max-w-[1100px] px-6 pb-6 pt-4">
            {loaded && <BallOverview summary={summary} stance={stance} person={person}
              onStance={(next) => { setStance(next); if (next && groupBy !== "ball") { setGroupBy("ball"); save(GROUP_KEY, "ball"); } }} onPerson={setPerson} />}
            {(stance || person) && (
              <div className="-mt-2 mb-4 flex items-center gap-2 text-[11px] text-dim">
                showing {stance === "you" ? "what waits on you" : stance === "them" ? `what you are waiting on${person ? ` from ${person === "reviewers" ? "any reviewer" : person}` : ""}` : "what is between others"}
                <button onClick={() => { setStance(undefined); setPerson(undefined); }} className="rounded border border-edge2 px-1.5 hover:text-ink">clear ×</button>
              </div>
            )}
            {groupBy === "ball" ? <>
            {showBall("you") && <Section title="Waiting on you" count={ballSections.you.length} tone="text-orange">
              {ballSections.you.map((row) => <TicketRow key={row.issue.key} row={row} ball={balls.get(row.issue.key)} {...rowProps} />)}
            </Section>}
            {showBall("them") && <Section title="You're waiting on" count={ballSections.them.length} tone="text-blue">
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
            <Section title="New since you looked" count={sections.fresh.length} tone="text-accent">
              {sections.fresh.map((row) => <TicketRow key={row.issue.key} row={row} ball={balls.get(row.issue.key)} {...rowProps} />)}
            </Section>
            <Section title="Needs a look" count={sections.flagged.length} tone="text-red">
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
              <div className="flex flex-col items-center gap-2 py-16 text-dim">
                <Icon name="check" size={20} className="text-green" />
                {rows.length === 0 ? "No tickets on the board." : filter === "new" ? "Nothing new since you last looked." : "Nothing matches."}
              </div>
            )}
            {!loaded && <p className="py-8 text-dim">Waiting for the board and GitHub… Connect a board under Settings → Workspaces if nothing shows up.</p>}
          </div>
        </div>
        {selected && settings && (
          <IssuePanel issue={selected} rejected={rejectedRe.test(selected.statusName)} onClose={() => setSelected(undefined)} onOpenDiff={setDiffPr} />
        )}
      </div>
      {diffPr && <PrScreen pr={diffPr} issue={selected} onClose={() => setDiffPr(undefined)} />}
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
      className={`cursor-pointer border-b border-edge px-4 last:border-b-0 hover:bg-card ${compact ? "py-1.5" : "py-2.5"} ${selectedKey === row.issue.key ? "bg-card" : ""}`}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex w-2 shrink-0 justify-center">{isNew && <span aria-label="New since you last looked" className="h-2 w-2 rounded-full bg-accent" />}</span>
        <button onClick={(e) => { e.stopPropagation(); window.open(row.issue.url); }} title={`Open ${row.issue.key} in the tracker`}
          className={`shrink-0 text-[11px] hover:underline ${isNew ? "font-bold text-ink" : "text-mut"}`}>{row.issue.key}</button>
        <span className={`min-w-0 flex-1 truncate ${isNew ? "text-ink" : "text-soft"}`} title={row.issue.summary}>{row.issue.summary}</span>
        {next && <ContinueButton next={next} />}
        {/* The agent Continue goes to is already on the button. */}
        {agents.filter((agent) => agent.link.sessionId !== next?.agent?.link.sessionId).slice(0, 2).map((agent) => <AgentChip key={agent.link.sessionId} agent={agent} />)}
        {agents.length > 3 && <span className="shrink-0 text-[10px] text-dim">+{agents.length - 3}</span>}
        <span className="hidden shrink-0 truncate text-[11px] text-dim @[560px]:inline">{row.issue.assignee ?? "unassigned"}</span>
        <span className="max-w-[140px] shrink-0 truncate rounded border border-edge2 px-1.5 text-[10px] leading-[16px] text-body" title={row.column !== row.issue.statusName ? `${row.issue.statusName} (${row.column})` : row.issue.statusName}>{row.issue.statusName}</span>
        {ball && ball.stance !== "done"
          ? <span className={`w-[64px] shrink-0 text-right text-[10px] ${ball.stance === "you" ? "text-orange" : ball.stance === "them" ? "text-blue" : "text-dim"}`}
              title={`${ballText(ball)} since ${new Date(ball.since).toLocaleString()}`}>waiting {relativeTime(ball.since).replace(" ago", "")}</span>
          : <span className="w-[64px] shrink-0 text-right text-[10px] text-dim" title="Last activity">{relativeTime(row.lastActivity || row.issue.updated).replace(" ago", "")}</span>}
      </div>
      {isNew && <p className="mt-1 pl-4 text-[11px] text-accent">{row.changes.join(" · ")}</p>}
      {row.flags.map((flag) => <p key={flag} className="mt-1 flex items-center gap-1.5 pl-4 text-[11px] text-red"><span aria-hidden>⚠</span>{flag}</p>)}
      {!compact && row.prs.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1 pl-4">
          {row.prs.map((pr) => <PrLine key={prKey(pr)} pr={pr} viewer={viewer} below={stackedOn(pr, allPrs)} move={moveOf(pr, viewer, requested)} onOpen={() => onOpenPr(row, pr)} />)}
        </div>
      )}
    </article>
  );
}

/** One PR: which it is, whose move, then who last committed and reviewed.
 *  The first two parts keep their width so the lines of a list align; the
 *  rest moves below them when the page is narrow. */
function PrLine({ pr, viewer, below, move, onOpen }: { pr: ActivityPr; viewer: string; below?: ActivityPr; move: Move; onOpen: () => void }) {
  const review = pr.lastReview && (reviewWords[pr.lastReview.state] ?? { text: pr.lastReview.state.toLowerCase(), tone: "text-body" });
  const who = (login: string) => (login === viewer ? "you" : login || "?");
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-0.5 text-[11px] leading-[18px]">
      <span className="flex w-[190px] min-w-0 items-center gap-1.5">
        <span title={checkWords[pr.checks] ?? "no checks"} className={`shrink-0 text-[9px] ${checkTone[pr.checks] ?? "text-edge3"}`}>●</span>
        <button onClick={(e) => { e.stopPropagation(); onOpen(); }} title={`${pr.title}\n${prKey(pr)}`} className="min-w-0 truncate text-body hover:text-ink hover:underline">
          <span className="text-dim">{pr.repo.split("/")[1]}</span>#{pr.number}
        </button>
        {pr.mergeable === "CONFLICTING" && pr.state === "OPEN" && <span className="shrink-0 text-red" title="Merge conflicts">conflicts</span>}
        {below && <span className="shrink-0 text-dim" title={`Stacked on ${prKey(below)} (${below.headRefName})`}>on #{below.number}</span>}
      </span>
      <span className="flex w-[230px] min-w-0"><MovePill move={move} /></span>
      {/* Below the PR, not squeezed beside it, once there is no room for a line of its own. */}
      <span className="flex min-w-[260px] flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 text-dim">
        {pr.lastCommit && <span className="truncate" title={pr.lastCommit.at}>pushed by <span className="text-body">{who(pr.lastCommit.author)}</span> {relativeTime(pr.lastCommit.at)}</span>}
        {pr.lastReview && review
          ? <span className="truncate" title={pr.lastReview.onHead ? "On the latest commit" : "On an older commit"}>
              <span className="text-body">{who(pr.lastReview.author)}</span> <span className={review.tone}>{review.text}</span> {relativeTime(pr.lastReview.at)}
              {!pr.lastReview.onHead && pr.state === "OPEN" && <span className="text-mut"> · before the last push</span>}
            </span>
          : pr.state === "OPEN" && <span>no reviews yet</span>}
        {pr.unresolvedThreads > 0 && <span className="text-orange">{pr.unresolvedThreads} open thread{pr.unresolvedThreads === 1 ? "" : "s"}</span>}
      </span>
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
    <div className="border-b border-edge last:border-b-0">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full min-w-0 items-center gap-2 px-4 py-2.5 text-left hover:bg-card">
        <span className="flex w-2 shrink-0 justify-center text-dim"><Icon name={open ? "chevronDown" : "chevronRight"} size={10} /></span>
        <Icon name="layers" size={12} className="shrink-0 text-dim" />
        <span className="shrink-0 text-soft">Stack of {rows.length}</span>
        <span className="min-w-0 truncate text-[11px] text-dim">
          {base && <>in {base.repo.split("/")[1]}, starting at #{base.number} into {base.baseRefName}</>}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-dim">{summary}</span>
      </button>
      {open && (
        <div className="border-t border-edge bg-panel/50">
          {rows.map((row) => {
            const pr = row.prs.find((p) => p.state === "OPEN")!;
            return (
              <div key={row.issue.key} onClick={() => onOpen(row)} role="button"
                className={`flex min-w-0 cursor-pointer items-center gap-2 border-b border-edge px-4 py-1.5 pl-10 text-[11px] last:border-b-0 hover:bg-card ${selectedKey === row.issue.key ? "bg-card" : ""}`}>
                <span className="shrink-0 text-mut">{row.issue.key}</span>
                <span className="min-w-0 flex-1 truncate text-soft" title={row.issue.summary}>{row.issue.summary}</span>
                <button onClick={(e) => { e.stopPropagation(); onOpenPr(row, pr); }} className="shrink-0 text-body hover:text-ink hover:underline">#{pr.number}</button>
                {stackedOn(pr, allPrs) && <span className="shrink-0 text-dim">on #{stackedOn(pr, allPrs)!.number}</span>}
                {agentsForPr(pr, row.issue.key, links).slice(0, 1).map((agent) => <AgentChip key={agent.link.sessionId} agent={agent} />)}
                <span className={`shrink-0 text-[9px] ${checkTone[pr.checks] ?? "text-edge3"}`} title={checkWords[pr.checks] ?? "no checks"}>●</span>
                <MovePill move={moveOf(pr, viewer, requested)} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
