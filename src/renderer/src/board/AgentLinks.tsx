import { useEffect, useState } from "react";
import type { PrComment, PrDetail } from "../../../main/github.js";
import { agentLabels, type Agent } from "../../../shared/agents.js";
import type { BallAction } from "../../../shared/activity.js";
import { continueTarget, needsYou, reasonLabel, type AgentLink, type LinkedAgent, type PastSession } from "../../../shared/agentLinks.js";
import { StatusMark, statusLabels, statusTones } from "../chrome/SessionIcon.js";
import { focusTerminal, openTerminalTab } from "../lib/bus.js";
import { Icon } from "./icons.js";
import { relativeTime } from "./prUi.js";

// Running terminal agents next to the PRs they work on: a chip wherever a PR
// is listed, the Continue button on waiting work, and the helpers the PR
// screen's agent bar (PrAgentPanel) uses to hand an agent an instruction.

/** A running agent in one line; clicking brings its terminal to the front.
 *  A span, since lists put it inside rows that are buttons themselves. */
export function AgentChip({ agent, showReason = false }: { agent: LinkedAgent; showReason?: boolean }) {
  const { link } = agent;
  const tone = needsYou(link.status) ? "border-orange/60 text-orange" : link.status === "working" ? "border-accent/40 text-accent" : "border-edge2 text-body";
  const open = (e: React.SyntheticEvent) => { e.stopPropagation(); focusTerminal(link.termId); };
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); } }}
      title={`${link.title ?? agentLabels[link.agent]}\n${statusLabels[link.status]} · ${reasonLabel(agent)}\nOpen its terminal`}
      className={`inline-flex h-5 max-w-full shrink-0 cursor-pointer items-center gap-1.5 truncate rounded-full border px-2 text-[11px] hover:bg-card2 ${tone}`}
    >
      <span className={statusTones[link.status].text}><StatusMark status={link.status} size={9} /></span>
      <span>{agentLabels[link.agent]}</span>
      <span>{needsYou(link.status) ? "needs you" : statusLabels[link.status].toLowerCase()}</span>
      {showReason && <span className="truncate text-mut">· {reasonLabel(agent)}</span>}
    </span>
  );
}

/** What a running agent is asked when a review thread is handed to it. It
 *  already sits on the branch, so no checkout preamble. */
export function threadInstruction(pr: { repo: string; number: number }, thread: PrComment[]): string {
  const [first, ...replies] = thread;
  const where = first.path ? `, ${first.path}${first.line ? `:${first.line}` : ""},` : "";
  const quote = (text: string) => text.replace(/\s+/g, " ").trim();
  return [
    `Review comment on PR #${pr.number} (${pr.repo})${where} from ${first.author}: "${quote(first.body)}"`,
    ...replies.map((reply) => `${reply.author} replied: "${quote(reply.body)}"`),
    "Address it, run the project's checks, and show me the diff before pushing.",
  ].join("\n");
}

export interface Suggestion { label: string; text: string }

export function suggestions(pr: { repo: string; number: number }, detail: PrDetail | null | undefined, openThreads: number, running: boolean): Suggestion[] {
  const list: Suggestion[] = [];
  const base = detail?.baseRefName ?? "the base branch";
  const branch = detail ? ` (branch ${detail.headRefName})` : "";
  const onIt = running ? "" : ` Check out the PR branch${branch} in this checkout first if it is not on it.`;
  if (openThreads > 0) list.push({
    label: `Address ${openThreads} open thread${openThreads === 1 ? "" : "s"}`,
    text: `Address the ${openThreads} unresolved review thread${openThreads === 1 ? "" : "s"} on PR #${pr.number} in ${pr.repo}: read them with \`gh api repos/${pr.repo}/pulls/${pr.number}/comments\`, fix each, run the project's checks, and show me the diff before pushing.${onIt}`,
  });
  if (detail?.checks.some((check) => /fail|error|cancel|timed_out/i.test(check.state))) list.push({
    label: "Fix failing checks",
    text: `CI is failing on PR #${pr.number} in ${pr.repo}. Find the failing run with \`gh pr checks ${pr.number}\` and \`gh run view --log-failed\`, reproduce it locally, fix the root cause without loosening tests, and show me the diff before pushing.${onIt}`,
  });
  if (detail?.mergeable === "CONFLICTING") list.push({
    label: "Resolve conflicts",
    text: `PR #${pr.number} in ${pr.repo} conflicts with ${base}. Merge origin/${base} into the branch, resolve every conflict keeping both intents, run the checks, and show me the result before pushing.${onIt}`,
  });
  if (running) list.push(
    { label: "Where are you?", text: `Give me a short status on PR #${pr.number}: what is done, what is left, and anything you need from me.` },
    { label: "Push it", text: "Looks good: commit in one line without agent authorship and push." },
  );
  else list.push({
    label: "Review my PR",
    text: `Read the diff of PR #${pr.number} in ${pr.repo} (\`gh pr diff ${pr.number}\`) and look for bugs, missed cases and missing tests.${onIt} Make the fixes, run the checks, and show me the diff before committing.`,
  });
  return list;
}

/** The agent's latest reply, asked again whenever the session reports in. */
export function useLastWords(link: AgentLink | undefined): string | undefined {
  const [said, setSaid] = useState<string>();
  const id = link?.sessionId;
  const stamp = link?.updatedAt;
  useEffect(() => {
    if (!id || id.startsWith("pending:")) { setSaid(undefined); return; }
    let cancelled = false;
    void window.deck.agents.lastWords(id).then((text) => { if (!cancelled) setSaid(text ?? undefined); }, () => {});
    return () => { cancelled = true; };
  }, [id, stamp]);
  return said;
}

/** What picking a waiting ticket up means, and how: back to the agent on it,
 *  a finished session resumed, or a new agent with the task in hand. */
export interface Continuation {
  label: string;
  hint: string;
  kind: "live" | "resume" | "start" | "open";
  /** The running agent it goes to, for kind "live". */
  agent?: LinkedAgent;
  run: () => void;
}

export interface ContinueInput {
  pr?: { repo: string; number: number; url: string; headRefName: string; baseRefName: string };
  action: BallAction;
  ticket: { key: string; url: string };
  agents: LinkedAgent[];
  /** The agent waiting on the user, when that is what the ticket waits on. */
  waitingAgent?: LinkedAgent;
  past?: PastSession;
  /** Local checkout of the PR's repository, for a new agent. */
  cwd?: string;
  agent: Agent;
  onOpenPr: () => void;
}

const startPrompt = (pr: NonNullable<ContinueInput["pr"]>, action: BallAction): string => {
  const ref = `${pr.url} (branch ${pr.headRefName})`;
  const finish = "Run the project's checks and show me the diff before pushing.";
  switch (action) {
    case "re-review": return `Review again: ${pr.url}. Focus on what changed since my last review and whether my earlier comments were addressed.`;
    case "address": return `Address the review feedback on ${ref}: read the unresolved threads with \`gh pr view ${pr.number} -R ${pr.repo} --comments\` and \`gh api repos/${pr.repo}/pulls/${pr.number}/comments\`, check out the branch if this checkout is not on it, and make the changes. ${finish}`;
    case "fix CI": return `CI is failing on ${ref}. Find the failing run with \`gh pr checks ${pr.number} -R ${pr.repo}\` and \`gh run view --log-failed\`, check out the branch if needed, and fix the root cause without loosening tests. ${finish}`;
    case "resolve conflicts": return `${ref} conflicts with ${pr.baseRefName}. Check out the branch, merge origin/${pr.baseRefName} into it and resolve every conflict keeping both intents. ${finish}`;
    case "finish draft": return `Pick up the draft PR ${ref}: check out the branch, tell me briefly what is done and what is left, then carry on.`;
    default: return `Review this PR: ${pr.url}`;
  }
};

const startWords: Partial<Record<BallAction, string>> = {
  review: "Start review", "re-review": "Start re-review", address: "Start on the feedback", "fix CI": "Start fixing CI",
  "resolve conflicts": "Start on the conflicts", "finish draft": "Pick up the draft",
};

export function continuation(input: ContinueInput): Continuation | undefined {
  const { pr, action, ticket, agents, waitingAgent, past, cwd, agent, onOpenPr } = input;
  const reviewing = action === "review" || action === "re-review";
  const live = waitingAgent ?? continueTarget(agents, reviewing);
  if (live) {
    const name = agentLabels[live.link.agent];
    return {
      kind: "live",
      agent: live,
      label: needsYou(live.link.status) ? `Answer ${name}` : `Continue in ${name}`,
      hint: `${live.link.title ?? name} · ${statusLabels[live.link.status].toLowerCase()} · ${reasonLabel(live)}\nOpens its terminal`,
      run: () => focusTerminal(live.link.termId),
    };
  }
  if (action === "move ticket") return { kind: "open", label: "Move the ticket ↗", hint: `Open ${ticket.key} in the tracker`, run: () => window.open(ticket.url) };
  if (!pr) return undefined;
  if (action === "merge") return { kind: "open", label: "Open to merge", hint: "Approved on the latest commit: open the PR to merge it", run: onOpenPr };
  if (past) {
    const name = agentLabels[past.agent];
    return {
      kind: "resume",
      label: `Resume ${name}`,
      hint: `${past.title ?? name} · ${past.reason === "opened" ? "opened this PR" : "worked on this PR"} · ended ${relativeTime(new Date(past.updatedAt).toISOString())}\nResumes that session in a new tab`,
      run: () => openTerminalTab({ sessionId: past.sessionId, agent: past.agent, cwd: past.cwd, issueKey: ticket.key }),
    };
  }
  return {
    kind: "start",
    label: `${startWords[action] ?? "Start"} in ${agentLabels[agent]}`,
    hint: `No agent has worked on this PR yet; starts ${agentLabels[agent]} in ${cwd ?? "the default folder"} with:\n${startPrompt(pr, action)}`,
    run: () => openTerminalTab({ cwd, agent, prompt: startPrompt(pr, action), issueKey: ticket.key }),
  };
}

const continueTone: Record<Continuation["kind"], string> = {
  live: "border-accent/40 bg-accent/15 font-semibold text-accent hover:bg-accent/25",
  resume: "border-accent/40 bg-accent/15 font-semibold text-accent hover:bg-accent/25",
  start: "border-edge2 font-medium text-soft hover:border-edge3 hover:text-ink",
  open: "border-edge2 font-medium text-soft hover:border-edge3 hover:text-ink",
};
// An agent blocked on the user gets the one solid button on the row.
const answerTone = "border-accent bg-accent font-semibold text-bg hover:bg-accent/90";

/** The one-click way back into a ticket that waits on the user. */
export function ContinueButton({ next }: { next: Continuation }) {
  const status = next.agent?.link.status;
  return (
    <span role="button" tabIndex={0} title={next.hint}
      onClick={(e) => { e.stopPropagation(); next.run(); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); next.run(); } }}
      className={`inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-[12px] ${next.kind === "live" && status && needsYou(status) ? answerTone : continueTone[next.kind]}`}>
      {next.kind === "live" && status ? <StatusMark status={status} size={10} /> : <Icon name={next.kind === "resume" ? "clock" : next.kind === "start" ? "play" : "external"} size={11} />}
      {next.label}
    </span>
  );
}
