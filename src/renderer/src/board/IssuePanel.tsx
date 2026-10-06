import { AgentSelect, useAgentChoice } from "../agents/AgentSelect.js";
import { useEffect, useMemo, useState } from "react";
import type { IssuePr } from "../../../main/github.js";
import type { RepoDir } from "../../../main/providers.js";
import type { BoardIssue } from "../../../main/board/types.js";
import type { AgentSession } from "../../../main/sessions.js";
import { StatusMark, statusLabels, statusTones } from "../chrome/SessionIcon.js";
import { agentsForTicket, needsYou, reasonLabel } from "../../../shared/agentLinks.js";
import type { ActivityPr } from "../../../shared/activity.js";
import { prKey } from "../../../shared/prs.js";
import { focusTerminal } from "../lib/bus.js";
import { useBoardActivity } from "../lib/useActivity.js";
import { useAgentLinks } from "../lib/useAgentLinks.js";
import { usePrInbox } from "../lib/useInbox.js";
import { useTabs } from "../store.js";
import { MovePill, moveOf } from "./prUi.js";

const section = "pt-1 text-[11px] font-semibold tracking-[0.06em] text-mut";
// An agent waiting on the user is the user's move, so its row turns orange.
const agentRow = (waiting: boolean) =>
  `flex items-center gap-2.5 rounded-[10px] border px-3 py-2 text-left hover:border-edge3 ${waiting ? "border-orange/40 bg-orange/10" : "border-edge bg-card"}`;

export interface IssuePanelProps {
  issue: BoardIssue;
  rejected: boolean;
  onClose: () => void;
  onOpenDiff: (pr: IssuePr) => void;
}

export function IssuePanel({ issue, rejected, onClose, onOpenDiff }: IssuePanelProps) {
  const { newTab, tabs, focusTab } = useTabs();
  const [agent, setAgent] = useAgentChoice();
  const [prs, setPrs] = useState<IssuePr[]>();
  const [repos, setRepos] = useState<RepoDir[]>([]);
  const [repoPath, setRepoPath] = useState<string>("");
  const [sessions, setSessions] = useState<AgentSession[]>([]);

  useEffect(() => {
    setPrs(undefined);
    void window.deck.gh.prsForIssue(issue.key).then(setPrs);
    return window.deck.gh.onPrsChanged((key, next) => {
      if (key === issue.key) setPrs(next);
    });
  }, [issue.key]);

  useEffect(() => {
    void window.deck.search.listRepos().then(setRepos);
    void window.deck.sessions.list().then(setSessions);
    return window.deck.sessions.onChanged(setSessions);
  }, []);

  const linked = useMemo(
    () => sessions.filter((s) => s.issue_key === issue.key),
    [sessions, issue.key],
  );
  const openTermIds = new Set(tabs.map((t) => t.termId));
  // Agents working on the ticket's PRs without having been started from it:
  // the checkout is on a PR branch, or the agent opened the PR.
  const links = useAgentLinks();
  const { activity } = useBoardActivity();
  const inbox = usePrInbox();
  const requested = useMemo(() => new Set((inbox?.reviewRequested ?? []).map(prKey)), [inbox]);
  const onPrs = useMemo(() => {
    const ticketPrs = (activity?.tickets[issue.key] ?? []).map((key) => activity?.prs[key]).filter((pr): pr is ActivityPr => Boolean(pr));
    return agentsForTicket(issue.key, ticketPrs, links).filter((agent) => !linked.some((s) => s.session_id === agent.link.sessionId));
  }, [activity, links, linked, issue.key]);

  // A PR's repo is the best guess for where the agent should work.
  useEffect(() => {
    const prRepo = prs?.[0]?.repo.split("/")[1];
    const match = repos.find((r) => r.name === prRepo);
    if (match) setRepoPath((p) => p || match.path);
  }, [prs, repos]);

  const spinUp = () => {
    const prompt = rejected
      ? `${issue.key}: ${issue.summary} — the code was rejected in review. Look at the PR feedback and address it.`
      : `${issue.key}: ${issue.summary}`;
    void newTab({
      cwd: repoPath || undefined,
      agent,
      prompt,
      issueKey: issue.key,
    });
  };

  const continueSession = (s: AgentSession) => {
    if (s.term_id && openTermIds.has(s.term_id)) focusTab(s.term_id);
    else
      void newTab({ cwd: s.cwd, agent: s.agent, sessionId: s.session_id, issueKey: issue.key });
  };

  return (
    <div className="flex w-[400px] shrink-0 flex-col border-l border-edge bg-panel">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
        <span className="font-mono text-[11px] text-mut">{issue.key}</span>
        <span className="inline-flex h-[22px] items-center rounded-md border border-edge2 px-2 text-[12px] text-soft">{issue.statusName}</span>
        <button onClick={onClose} className="ml-auto text-mut hover:text-ink">
          ×
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4">
        <div className="text-[15px] font-semibold leading-snug text-ink">{issue.summary}</div>
        <div className="flex gap-2 text-[11px]">
          <span className="rounded-md bg-card2 px-2 py-0.5 text-body">
            {issue.assignee ?? "unassigned"}
          </span>
          <button
            onClick={() => window.open(issue.url)}
            className="rounded-md bg-card2 px-2 py-0.5 text-accent hover:underline"
          >
            open issue ↗
          </button>
        </div>

        <div className={section}>AGENTS</div>
        {linked.length === 0 && onPrs.length === 0 && (
          <div className="-mt-2 text-[12px] text-mut">no agent has touched this ticket</div>
        )}
        {linked.map((s) => {
          const g = statusTones[s.status];
          return (
            <button
              key={s.session_id}
              onClick={() => continueSession(s)}
              title={
                s.term_id && openTermIds.has(s.term_id) ? "Focus session" : "Continue session"
              }
              className={agentRow(needsYou(s.status))}
            >
              <span className={g.text}><StatusMark status={s.status} /></span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-soft">
                {s.title ?? s.session_id.slice(0, 8)}
              </span>
              <span className={`shrink-0 text-[11px] ${g.text}`}>
                {s.term_id && openTermIds.has(s.term_id) ? "focus →" : `${statusLabels[s.status].toLowerCase()} · continue →`}
              </span>
            </button>
          );
        })}
        {onPrs.map((agent) => {
          const g = statusTones[agent.link.status];
          return (
            <button
              key={agent.link.sessionId}
              onClick={() => focusTerminal(agent.link.termId)}
              title="Focus session"
              className={agentRow(needsYou(agent.link.status))}
            >
              <span className={g.text}><StatusMark status={agent.link.status} /></span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-soft">
                {agent.link.title ?? agent.link.sessionId.slice(0, 8)}
                <span className="text-mut"> · {reasonLabel(agent)}</span>
              </span>
              <span className={`shrink-0 text-[11px] ${g.text}`}>{statusLabels[agent.link.status].toLowerCase()} · focus →</span>
            </button>
          );
        })}
        <div
          className={`flex gap-2 ${rejected ? "rounded-md border border-red/40 bg-red/10 p-2" : ""}`}
        >
          <select
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            className="h-[30px] min-w-0 flex-1 rounded-lg border border-edge bg-card px-2 text-[12px] text-soft outline-none focus:border-edge3"
          >
            <option value="">default cwd</option>
            {repos.map((r) => (
              <option key={r.path} value={r.path}>
                {r.name}
              </option>
            ))}
          </select>
          <AgentSelect value={agent} onChange={setAgent} />
          <button
            onClick={spinUp}
            className={`h-[30px] shrink-0 rounded-lg border px-3 text-[12px] font-semibold ${
              rejected
                ? "border-red/40 text-red hover:bg-red/20"
                : "border-accent/30 bg-accent/15 text-accent hover:border-accent/60"
            }`}
          >
            {rejected ? "✗ fix rejection" : `✳ spin up ${agent}`}
          </button>
        </div>

        <div className={section}>PULL REQUESTS</div>
        {prs === undefined && <div className="-mt-2 text-[12px] text-mut">searching…</div>}
        {prs?.length === 0 && <div className="-mt-2 text-[12px] text-mut">none found</div>}
        {prs?.map((pr) => {
          // The search result has no review state; the activity cache does when it tracks the PR.
          const tracked = activity?.prs[prKey(pr)];
          return (
            <div
              key={`${pr.repo}#${pr.number}`}
              className="rounded-[10px] border border-edge bg-card p-3"
            >
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 font-mono text-[11px] text-mut">
                  {pr.repo.split("/")[1] ?? pr.repo}#{pr.number}
                </span>
                <span className="truncate text-[13px] font-medium text-ink">{pr.title}</span>
              </div>
              <div className="mt-2 flex items-center gap-3 text-[12px]">
                {tracked && activity
                  ? <MovePill move={moveOf(tracked, activity.viewer, requested)} />
                  : <span className="text-mut">{pr.isDraft ? "draft" : pr.state.toLowerCase()}</span>}
                <button onClick={() => onOpenDiff(pr)} className="ml-auto text-accent hover:underline">
                  view diff
                </button>
                <button onClick={() => window.open(pr.url)} className="text-mut hover:text-ink">
                  github ↗
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
