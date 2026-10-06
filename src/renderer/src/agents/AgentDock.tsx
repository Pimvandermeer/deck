import { useEffect, useRef, useState } from "react";
import { Icon } from "../board/icons.js";
import { onToggleAgentPanel } from "../lib/bus.js";
import { useAgentSessions } from "../lib/useSessions.js";
import { AgentChat } from "./AgentChat.js";
import { useChat } from "./ChatStore.js";

// Deck's agent from any page: a button in the bottom-right corner (like
// Linear's) that opens the conversation, either as a card or expanded into a
// drawer along the right edge for longer work.

export function AgentDock() {
  const [open, setOpen] = useState(() => localStorage.getItem("deck.agent.dock") === "open");
  const [expanded, setExpanded] = useState(() => localStorage.getItem("deck.agent.dock.expanded") === "expanded");
  const sessions = useAgentSessions();
  const { turns, reset } = useChat();
  const section = useRef<HTMLElement>(null);
  // Only a deliberate open takes focus; a dock restored at launch leaves it where it was.
  const focusOnOpen = useRef(false);
  const toggle = (next: boolean) => { localStorage.setItem("deck.agent.dock", next ? "open" : "closed"); focusOnOpen.current = next; setOpen(next); };
  const expand = (next: boolean) => { localStorage.setItem("deck.agent.dock.expanded", next ? "expanded" : "compact"); setExpanded(next); };

  useEffect(() => onToggleAgentPanel(() => toggle(!open)), [open]);
  useEffect(() => { if (open && focusOnOpen.current) section.current?.querySelector("textarea")?.focus(); }, [open]);

  // How many sessions the next question will carry, refreshed when the
  // sessions or the setting change.
  const [shared, setShared] = useState<{ shared: number; total: number }>();
  useEffect(() => {
    if (!open || !expanded) return;
    void window.deck.sharing.summary().then(setShared);
    return window.deck.onSettingsChanged(() => void window.deck.sharing.summary().then(setShared));
  }, [open, expanded, sessions]);

  if (!open) {
    return (
      <button onClick={() => toggle(true)} aria-label="Open agent" title="Ask deck's agent"
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-edge2 bg-panel px-3.5 py-2 text-[12px] text-ink shadow-[0_8px_30px_#0008] hover:border-edge3">
        <Icon name="sparkle" size={14} className="text-accent" />
        Agent
      </button>
    );
  }

  return (
    <section ref={section} aria-label="Agent dock" onKeyDown={(e) => { if (e.key === "Escape") toggle(false); }}
      className={expanded
        ? "fixed bottom-0 right-0 top-11 z-40 flex w-[min(640px,50vw)] flex-col overflow-hidden border-l border-edge2 bg-panel shadow-[0_12px_40px_#000a]"
        : "fixed bottom-4 right-4 z-40 flex h-[600px] max-h-[calc(100vh-6rem)] w-[440px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-edge2 bg-panel shadow-[0_12px_40px_#000a]"}>
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
        <Icon name="sparkle" size={14} className="text-accent" />
        <span className="text-[12px] font-bold text-ink">Agent</span>
        <div className="ml-auto flex items-center gap-1">
          {expanded && shared && shared.shared < shared.total && (
            <span title="Restricted in Settings → What deck may share with the agent" className="mr-1 text-[11px] text-orange">sharing {shared.shared} of {shared.total} sessions</span>
          )}
          {turns.length > 0 && <button onClick={reset} className="mr-1 rounded-md border border-edge2 px-2 py-0.5 text-[11px] text-body hover:text-ink">New chat</button>}
          <button onClick={() => expand(!expanded)} aria-label={expanded ? "Collapse agent panel" : "Expand agent panel"} title={expanded ? "Back to the small card" : "Expand along the right edge"}
            className={`rounded p-1 ${expanded ? "bg-card2 text-soft" : "text-dim hover:text-ink"}`}><Icon name="expand" size={12} /></button>
          <button onClick={() => toggle(false)} aria-label="Close agent dock" className="rounded p-1 text-dim hover:text-ink"><Icon name="x" size={12} /></button>
        </div>
      </div>
      <AgentChat compact={!expanded} sessions={sessions.filter((s) => s.status !== "ended")} />
    </section>
  );
}
