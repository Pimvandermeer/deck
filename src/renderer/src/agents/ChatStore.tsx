import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { AskEvent } from "../../../main/agentTurn.js";
import type { AgentSession } from "../../../main/sessions.js";
import type { Agent } from "../../../shared/agents.js";
import { useAgentChoice } from "./AgentSelect.js";
import { applyEvent, finishTurn, loadTurns, saveTurns, type ChatTurn } from "./ChatTurns.js";

// One conversation with deck's agent, shared by every page through the agent panel
// and kept in localStorage so switching pages, a reload or a restart does not
// lose it. The main process keeps the matching claude session id.

export type { ChatTurn } from "./ChatTurns.js";

interface Chat {
  turns: ChatTurn[];
  busy: boolean;
  agent: Agent;
  /** Switching agents starts a fresh conversation. */
  chooseAgent: (agent: Agent) => void;
  /** Claude model for the next turns; starts from Settings and can change mid-conversation. */
  model: string;
  setModel: (model: string) => void;
  ask: (question: string) => Promise<void>;
  /** Records something the user did outside the conversation, like answering a session. */
  note: (text: string) => void;
  reset: () => void;
  /** When set, the composer types into this session's terminal instead of asking deck. */
  replyTo?: AgentSession;
  setReplyTo: (session?: AgentSession) => void;
}

const STORAGE = "deck.agent.turns";

const ChatContext = createContext<Chat | undefined>(undefined);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [turns, setTurns] = useState<ChatTurn[]>(() => loadTurns(STORAGE));
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [agent, setAgent] = useAgentChoice();
  const [model, setModel] = useState("");
  const [replyTo, setReplyTo] = useState<AgentSession>();

  useEffect(() => { void window.deck.getSettings().then((settings) => setModel((m) => m || settings.askModel)); }, []);

  useEffect(() => saveTurns(STORAGE, turns), [turns]);

  useEffect(() => window.deck.ask.onEvent((event: AskEvent) => setTurns((t) => applyEvent(t, event))), []);

  const reset = useCallback(() => { void window.deck.ask.reset(); setTurns([]); }, []);
  const chooseAgent = useCallback((next: Agent) => { setAgent(next); reset(); }, [setAgent, reset]);
  const note = useCallback((text: string) => setTurns((t) => [...t, { role: "user", text, steps: [] }]), []);

  const ask = useCallback(async (question: string) => {
    if (busyRef.current || !question.trim()) return;
    busyRef.current = true;
    setBusy(true);
    setTurns((t) => [...t, { role: "user", text: question, steps: [] }, { role: "deck", text: "", steps: [] }]);
    try {
      const result = await window.deck.ask.send(question, agent, model || undefined);
      setTurns((t) => finishTurn(t, result));
    } catch (error) {
      setTurns((t) => [...t.slice(0, -1), { role: "deck", text: String(error), steps: [], error: true }]);
    } finally { busyRef.current = false; setBusy(false); }
  }, [agent, model]);

  return <ChatContext.Provider value={{ turns, busy, agent, chooseAgent, model, setModel, ask, note, reset, replyTo, setReplyTo }}>{children}</ChatContext.Provider>;
}

export function useChat(): Chat {
  const chat = useContext(ChatContext);
  if (!chat) throw new Error("useChat needs a ChatProvider");
  return chat;
}
