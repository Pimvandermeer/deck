import { useEffect, useMemo, useRef, useState } from "react";
import type { ConvMessage, IndexProgress, SearchHit } from "../../../main/indexer.js";
import { openTerminalTab } from "../lib/bus.js";

// Deep conversation search with a full transcript preview. The ⌘K overlay is
// the quick entry point; ⏎ on a conversation there lands here.

function ago(ts: number | null): string {
  if (!ts) return "";
  const d = Date.now() - ts;
  const days = Math.floor(d / 86_400_000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(d / 3_600_000);
  if (hours > 0) return `${hours}h ago`;
  return `${Math.max(1, Math.floor(d / 60_000))}m ago`;
}

/** Render a snippet, highlighting the ⟪match⟫ markers emitted by FTS5. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/⟪|⟫/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-accent/30 text-ink">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export interface SearchViewProps {
  initialQuery?: string;
  initialSessionId?: string;
}

export function SearchView({ initialQuery, initialSessionId }: SearchViewProps) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(initialSessionId);
  const [messages, setMessages] = useState<ConvMessage[]>([]);
  const [progress, setProgress] = useState<IndexProgress>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    void window.deck.search.progress().then(setProgress);
    return window.deck.search.onProgress(setProgress);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      if (!query.trim()) {
        setHits([]);
        return;
      }
      void window.deck.search.query(query).then(setHits);
    }, 150);
    return () => clearTimeout(t);
  }, [query]);

  // One row per session, keeping its best-ranked hit.
  const grouped = useMemo(() => {
    const seen = new Map<string, SearchHit>();
    for (const h of hits) if (!seen.has(h.session_id)) seen.set(h.session_id, h);
    return [...seen.values()];
  }, [hits]);

  const selected = grouped.find((h) => h.session_id === selectedId) ?? undefined;

  useEffect(() => {
    if (!selectedId) return;
    void window.deck.search.session(selectedId).then(setMessages);
  }, [selectedId]);

  const resumeSelected = () => {
    const hit = selected;
    if (!selectedId) return;
    openTerminalTab({ agent: hit?.agent, cwd: hit?.cwd ?? undefined, sessionId: selectedId });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-edge px-4">
        <span className="text-dim">⌕</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search Claude and Codex conversations…"
          className="w-full max-w-2xl bg-transparent text-sm text-ink outline-none placeholder:text-dim"
        />
        {progress && !progress.done && (
          <span className="ml-auto shrink-0 text-[11px] text-dim">
            indexing {progress.scanned}/{progress.total}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-[400px] shrink-0 overflow-y-auto border-r border-edge p-1.5">
          {grouped.length === 0 && query.trim() !== "" && (
            <div className="px-2 pt-3 text-xs text-dim">No matches in local conversations.</div>
          )}
          {grouped.map((hit) => (
            <button
              key={hit.session_id}
              onClick={() => setSelectedId(hit.session_id)}
              className={`block w-full rounded-md px-2.5 py-2 text-left hover:bg-card2 ${
                selectedId === hit.session_id ? "bg-card2" : ""
              }`}
            >
              <div className="truncate text-xs font-bold text-ink">
                {hit.title ?? hit.session_id}
              </div>
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-mut">
                <Snippet text={hit.snippet} />
              </div>
              <div className="mt-0.5 text-[11px] text-dim">
                {hit.agent} · {hit.project.replace(/^-Users-[^-]+-/, "")} · {ago(hit.last_at)}
              </div>
            </button>
          ))}
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selectedId ? (
            <>
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-4">
                <span className="truncate text-xs text-mut">{selected?.title ?? selectedId}</span>
                <button
                  onClick={resumeSelected}
                  className="ml-auto shrink-0 rounded-md border border-edge2 px-2 py-1 text-[11px] text-ink hover:border-accent hover:text-accent"
                >
                  Resume in terminal →
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {messages.map((m, i) => (
                  <div key={i} className="mb-3">
                    <div
                      className={`mb-0.5 text-[11px] uppercase tracking-wide ${
                        m.role === "user" ? "text-accent" : "text-dim"
                      }`}
                    >
                      {m.role}
                    </div>
                    <div
                      className={`whitespace-pre-wrap break-words text-xs leading-5 ${
                        m.role === "user"
                          ? "border-l-2 border-accent bg-card2 px-3 py-1.5 text-soft"
                          : "text-ink/90"
                      }`}
                    >
                      {m.text.length > 4000 ? `${m.text.slice(0, 4000)}…` : m.text}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-dim">
              Select a result to read the conversation
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
