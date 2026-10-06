import type { AskEvent } from "../../../main/agentTurn.js";
import { Markdown } from "../board/Markdown.js";

// One conversation with a deck assistant, as the agent panel and the
// PR review panel all render it, plus the helpers that keep it in localStorage.

export interface ChatTurn {
  role: "user" | "deck";
  text: string;
  /** Deck tools the assistant used while answering. */
  steps: string[];
  error?: boolean;
}

const KEEP = 200;

export function loadTurns(storageKey: string): ChatTurn[] {
  try {
    const turns = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as ChatTurn[];
    // An answer that was still streaming when the page went away is not coming back.
    return turns.map((turn, i) => i === turns.length - 1 && turn.role === "deck" && !turn.text
      ? { ...turn, text: "Interrupted before deck answered. Ask again.", error: true } : turn);
  } catch { return []; }
}

export function saveTurns(storageKey: string, turns: ChatTurn[]): void {
  try { localStorage.setItem(storageKey, JSON.stringify(turns.slice(-KEEP))); } catch { /* storage unavailable */ }
}

/** A streamed event lands on the deck turn that is still being written. */
export function applyEvent(turns: ChatTurn[], event: AskEvent): ChatTurn[] {
  const last = turns.at(-1);
  if (!last || last.role !== "deck") return turns;
  const next = event.type === "text" ? { ...last, text: last.text + event.text } : { ...last, steps: [...last.steps, `${event.name} ${event.input}`] };
  return [...turns.slice(0, -1), next];
}

/** The finished answer replaces whatever streamed in; a failure shows as one. */
export function finishTurn(turns: ChatTurn[], result: { ok: boolean; text: string; error?: string }): ChatTurn[] {
  const last = turns.at(-1);
  if (!last || last.role !== "deck") return turns;
  const text = result.ok ? result.text || last.text : result.error || "Could not get an answer.";
  return [...turns.slice(0, -1), { ...last, text: text || "No answer.", error: !result.ok }];
}

export function ChatTurns({ turns }: { turns: ChatTurn[] }) {
  return (
    <>
      {turns.map((turn, i) => turn.role === "user" ? (
        <div key={i} className="max-w-[85%] self-end whitespace-pre-wrap rounded-xl border border-edge2 bg-card2 px-4 py-2.5 text-[12px] text-soft">{turn.text}</div>
      ) : (
        <div key={i} className="text-[12px]">
          {turn.steps.length > 0 && (
            <ol className="mb-2 flex flex-col gap-1 text-[11px] text-dim" aria-label="Deck tools used">
              {turn.steps.map((step, j) => <li key={j} className="truncate"><span className="text-accent">⚙</span> {step}</li>)}
            </ol>
          )}
          {turn.text ? (turn.error ? <span className="text-red">{turn.text}</span> : <Markdown>{turn.text}</Markdown>) : <span className="text-dim">thinking…</span>}
        </div>
      ))}
    </>
  );
}
