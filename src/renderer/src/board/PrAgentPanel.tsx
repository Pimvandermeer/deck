import { useEffect, useRef, useState, type ReactNode } from "react";
import type { IssuePr, PrDetail } from "../../../main/github.js";
import { agentLabels, type Agent } from "../../../shared/agents.js";
import { reasonLabel, type AgentLink, type LinkedAgent } from "../../../shared/agentLinks.js";
import { AgentSelect, useAgentChoice } from "../agents/AgentSelect.js";
import { ChatTurns } from "../agents/ChatTurns.js";
import { focusTerminal, openTerminalTab } from "../lib/bus.js";
import { AgentChip, suggestions, useLastWords } from "./AgentLinks.js";
import { Icon } from "./icons.js";
import type { ReviewChat } from "./useReviewChat.js";

// The review assistant next to the diff: a conversation about this PR whose
// findings arrive as draft comments in the review screen. It is not a
// terminal session, so it never shows up in the sidebar; work that edits the
// branch (improving your own PR, addressing feedback) still goes to a proper
// coding agent in a terminal tab.

const isAuthor = (detail: PrDetail | null | undefined) =>
  Boolean(detail && detail.viewer && detail.viewer === detail.author);

const DRAFT_PROMPT = "Review the diff for real problems — bugs, missed cases, unclear naming, duplicated logic, missing tests — and add each finding as a draft comment on the right line. Skip style nits. Then summarise what you drafted in a few lines.";
const EXPLAIN_PROMPT = "Walk me through this change: what it does, how the pieces fit together, and anything risky or surprising I should look at first.";

const improvePrompt = (pr: IssuePr, detail: PrDetail | null | undefined) =>
  `Read the diff of my PR #${pr.number} in ${pr.repo} (\`gh pr diff ${pr.number}\`)` +
  (detail ? `, on branch ${detail.headRefName},` : "") +
  ` and look for what is worth improving before others review it: bugs, missed edge cases, unclear names, duplicated logic, missing tests. Make the changes on the branch in this checkout, run the project's checks, and show me the diff before committing.`;

const fixPrompt = (pr: IssuePr, detail: PrDetail | null | undefined) =>
  `Address the open review feedback on PR #${pr.number} in ${pr.repo}` +
  (detail ? ` (branch ${detail.headRefName})` : "") +
  `: read the unresolved threads with \`gh api repos/${pr.repo}/pulls/${pr.number}/comments\` and \`gh pr view ${pr.number} --comments\`, check out the PR branch if this checkout is not on it, make the changes, run the project's checks, and commit in one line without agent authorship. Show me the diff before pushing.`;

export interface PrAgentPanelProps {
  pr: IssuePr;
  detail: PrDetail | null | undefined;
  cwd: string | undefined;
  issueKey?: string;
  agent: Agent;
  onAgent: (agent: Agent) => void;
  chat: ReviewChat;
  onClose: () => void;
}

export function PrAgentPanel({ pr, detail, cwd, issueKey, agent, onAgent, chat, onClose }: PrAgentPanelProps) {
  const { turns, busy, ask, reset } = chat;
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [turns]);
  useEffect(() => { input.current?.focus(); }, []);

  const send = (question: string) => { setDraft(""); void ask(question); };
  const startCodingAgent = (prompt: string) => openTerminalTab({ cwd, agent, prompt, issueKey });

  const action = (label: string, icon: "pencil" | "sparkle" | "check", onClick: () => void, title: string, disabled = false) => (
    <button key={label} onClick={onClick} disabled={disabled} title={title}
      className="flex items-center gap-1 rounded-md border border-edge2 px-2 py-0.5 text-[11px] text-body hover:border-edge3 hover:text-ink disabled:opacity-40">
      <Icon name={icon} size={10} /> {label}
    </button>
  );

  return (
    <section aria-label="Review assistant" className="absolute bottom-0 right-0 top-0 z-30 flex w-[440px] flex-col border-l border-edge bg-panel shadow-xl font-sans">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-edge px-3 text-[13px]">
        <Icon name="sparkle" className="text-accent" />
        <span className="font-medium text-ink">Review assistant</span>
        <span className="truncate font-mono text-[12px] text-mut">#{pr.number}</span>
        {turns.length > 0 && <button onClick={reset} className="ml-auto rounded-md border border-edge2 px-2 py-0.5 text-[11px] text-body hover:text-ink" title="Start the conversation over (drafts stay)">New chat</button>}
        <button onClick={onClose} className={`${turns.length > 0 ? "" : "ml-auto"} text-dim hover:text-ink`} aria-label="Close review assistant" title="Close (a)">
          <Icon name="x" size={11} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-edge px-3 py-1.5">
        {isAuthor(detail) ? (
          <>
            {action("Improve on branch", "sparkle", () => startCodingAgent(improvePrompt(pr, detail)), "A coding agent improves your diff in a terminal tab", !cwd)}
            {action("Address feedback", "check", () => startCodingAgent(fixPrompt(pr, detail)), "A coding agent addresses open review threads in a terminal tab", !cwd)}
          </>
        ) : (
          <>
            {action("Draft review comments", "pencil", () => send(DRAFT_PROMPT), "Reviews the diff and puts findings in the review screen as drafts", busy)}
            {action("Explain the change", "sparkle", () => send(EXPLAIN_PROMPT), "A guided tour of the diff", busy)}
          </>
        )}
        {!cwd && <span className="ml-auto text-[11px] text-dim">no local checkout</span>}
      </div>
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
        {turns.length === 0 ? (
          <div className="flex flex-col gap-2 text-[12px] leading-relaxed text-mut">
            <p>Ask anything about this pull request. The assistant reads the diff, the existing threads and the local checkout.</p>
            <p>Review comments it writes appear as <span className="text-accent">drafts</span> in the diff for you to edit and send with your review; nothing goes to GitHub on its own.</p>
            <p>Select lines in the diff and choose <span className="text-soft">Ask agent</span> to bring them here.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3"><ChatTurns turns={turns} /></div>
        )}
      </div>
      <div className="border-t border-edge p-2">
        <div className="rounded-xl border border-edge2 bg-card">
          <textarea
            ref={input}
            aria-label="Ask the review assistant"
            value={draft}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(draft); } }}
            placeholder={busy ? "thinking…" : "Ask about this PR…"}
            disabled={busy}
            className="w-full resize-none bg-transparent px-3 pt-2.5 text-[13px] text-ink placeholder:text-dim focus:outline-none disabled:opacity-50"
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            <fieldset disabled={busy}><AgentSelect value={agent} onChange={onAgent} /></fieldset>
            <button aria-label="Send" title="Send (Enter)" disabled={busy || !draft.trim()} onClick={() => send(draft)}
              className="ml-auto flex h-6 w-6 items-center justify-center rounded-full bg-accent text-bg disabled:opacity-30">↑</button>
          </div>
        </div>
      </div>
    </section>
  );
}

export interface PrAgentBarProps {
  pr: { repo: string; number: number; title: string };
  detail: PrDetail | null | undefined;
  ticketKey?: string;
  /** The agents on this PR, the one waiting on the user first. */
  linked: LinkedAgent[];
  openThreads: number;
  /** The local checkout a new agent would start in. */
  cwd?: string;
  /** A message prepared elsewhere (a review thread handed over), opened in the composer. */
  draft?: { text: string; at: number };
  /** The PR screen's tabs, on the left of the row. */
  children: ReactNode;
}

/** The PR screen's tab row with the agents on this PR on its right: jump to
 *  one, or type it an instruction in a composer that opens below the row.
 *  With none running, the same composer starts one in the local checkout. */
export function PrAgentBar({ pr, detail, ticketKey, linked, openThreads, cwd, draft, children }: PrAgentBarProps) {
  const [agent, setAgent] = useAgentChoice();
  const [targetId, setTargetId] = useState<string>();
  const target = linked.find((entry) => entry.link.sessionId === targetId) ?? linked[0];
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string }>();
  const box = useRef<HTMLTextAreaElement>(null);
  const said = useLastWords(target?.link);

  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    setOpen(true);
    setStatus(undefined);
    setTimeout(() => box.current?.focus(), 0);
  }, [draft?.at]);

  const running = Boolean(target);
  const asking = target?.link.status === "needs_input";
  const ideas = suggestions(pr, detail, openThreads, running);
  const lastWords = target?.link.status === "needs_review" && target.link.reviewNote ? target.link.reviewNote : said;
  const toggle = () => { setOpen((o) => !o); setStatus(undefined); };

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    if (!target) {
      openTerminalTab({ cwd, agent, prompt: body, issueKey: ticketKey });
      setStatus({ tone: "ok", text: `Started ${agentLabels[agent]} in ${cwd ?? "the default folder"}` });
      setText("");
      setOpen(false);
      return;
    }
    const result = await window.deck.agents.send(target.link.sessionId, body);
    if (result.ok) {
      setStatus({ tone: "ok", text: target.link.status === "working" ? "Sent; it picks it up after the current step" : "Sent" });
      setText("");
      setOpen(false);
    } else setStatus({ tone: "error", text: result.error });
  };

  return (
    <div className="shrink-0 border-b border-edge">
      <div className="flex h-11 min-w-0 items-center gap-2 px-5">
        {children}
        <span className="min-w-0 flex-1" />
        {status && !open && <span className={`min-w-0 truncate text-[12px] ${status.tone === "ok" ? "text-mut" : "text-red"}`}>{status.text}</span>}
        {target ? (
          <>
            <span className="flex min-w-0"><AgentChip agent={target} showReason /></span>
            {linked.length > 1 && (
              <select aria-label="Agent" value={target.link.sessionId} onChange={(e) => setTargetId(e.target.value)}
                className="h-7 shrink-0 rounded-md border border-edge2 bg-card px-1.5 text-[12px] text-body outline-none">
                {linked.map((entry) => <option key={entry.link.sessionId} value={entry.link.sessionId}>{agentLabels[entry.link.agent]} · {reasonLabel(entry)}</option>)}
              </select>
            )}
            <button onClick={() => focusTerminal(target.link.termId)}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] ${asking ? "border-orange/40 bg-orange/15 font-semibold text-orange hover:bg-orange/25" : "border-edge2 text-soft hover:border-edge3 hover:text-ink"}`}>
              <Icon name="terminal" size={11} /> {asking ? "Answer in terminal" : "Open terminal"}
            </button>
            <button onClick={toggle} aria-expanded={open}
              className={`inline-flex h-7 shrink-0 items-center rounded-md border px-2.5 text-[12px] font-semibold text-accent ${open ? "border-accent/60 bg-accent/25" : "border-accent/30 bg-accent/20 hover:bg-accent/25"}`}>
              Message agent
            </button>
          </>
        ) : (
          <>
            <span className="min-w-0 truncate text-[12px] text-mut" title={detail ? `None has ${detail.headRefName} checked out` : undefined}>No agent running on this PR</span>
            <button onClick={toggle} aria-expanded={open}
              className={`inline-flex h-7 shrink-0 items-center rounded-md border px-2.5 text-[12px] ${open ? "border-accent/50 text-accent" : "border-edge2 text-soft hover:border-edge3 hover:text-ink"}`}>
              Start an agent on it
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-edge bg-panel px-5 py-3 text-[12px]">
          {target && lastWords && (
            <p className="truncate text-mut" title={lastWords}><span className="text-soft">{agentLabels[target.link.agent]}</span> · “{lastWords}”</p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {ideas.map((idea) => (
              <button key={idea.label} onClick={() => { setText(idea.text); box.current?.focus(); }}
                className="h-6 rounded-full border border-edge2 px-2.5 text-body hover:border-edge3 hover:text-ink">{idea.label}</button>
            ))}
          </div>
          {asking && (
            <p className="rounded-md border border-orange/40 bg-orange/10 px-2.5 py-1.5 text-orange">
              It is waiting on a question or permission prompt; a message now would answer that prompt. Answer it in the terminal first.
            </p>
          )}
          <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={3}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder={target ? `Tell ${agentLabels[target.link.agent]} what to do next…` : "What should the new agent do?"}
            className="w-full resize-y rounded-md border border-edge2 bg-card px-2.5 py-1.5 text-[13px] text-soft placeholder:text-dim focus:border-accent focus:outline-none" />
          <div className="flex items-center gap-2">
            {!target && <AgentSelect value={agent} onChange={setAgent} />}
            <span className="min-w-0 flex-1 truncate text-mut">
              {target
                ? `Typed into ${agentLabels[target.link.agent]}'s terminal${target.link.status === "working" ? "; it is mid-task, so it reads this after the current step" : ""}`
                : cwd ? `Starts in ${cwd}` : "No local checkout found; starts in the default folder"}
            </span>
            {status?.tone === "error" && <span className="shrink-0 text-red">{status.text}</span>}
            <button onClick={() => void send()} disabled={!text.trim() || asking}
              className="h-7 shrink-0 rounded-md bg-accent px-3 font-semibold text-bg hover:bg-accent/90 disabled:opacity-40">
              {target ? "Send" : `Start ${agentLabels[agent]}`} <span className="font-mono font-normal opacity-70">⌘↵</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
