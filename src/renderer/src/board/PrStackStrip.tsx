import { useEffect, useRef, useState } from "react";
import type { PrStack, StackedPr } from "../../../main/github.js";
import { openPullRequest } from "../lib/bus.js";
import { Icon } from "./icons.js";

function Entry({ repo, pr }: { repo: string; pr: StackedPr }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <button onClick={() => openPullRequest({ repo, ...pr })} title={`${pr.title} — by ${pr.author}`}
        className="flex min-w-0 flex-1 items-center gap-1 rounded px-1.5 py-0.5 text-left text-body hover:bg-card2 hover:text-ink">
        <span className="shrink-0 font-mono text-mut">#{pr.number}</span>
        <span className="min-w-0 flex-1 truncate text-body">{pr.title}</span>
      </button>
      <button onClick={() => window.open(pr.url)} title={`Open #${pr.number} on GitHub`} aria-label={`Open #${pr.number} on GitHub`}
        className="shrink-0 rounded p-1 text-dim hover:bg-card2 hover:text-ink">
        <Icon name="external" size={10} />
      </button>
    </span>
  );
}

/** This PR's place in its branch stack, as a position pill that opens the
 *  whole chain. Renders nothing when the PR stands alone. */
export function PrStackStrip({ repo, number, title, headRefName, baseRefName }: {
  repo: string;
  number: number;
  title: string;
  headRefName?: string;
  baseRefName?: string;
}) {
  const [stack, setStack] = useState<PrStack>();
  const [open, setOpen] = useState(false);
  const popup = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => { if (!popup.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", dismiss); window.removeEventListener("keydown", onKey); };
  }, [open]);

  useEffect(() => {
    setStack(undefined);
    setOpen(false);
    if (!headRefName && !baseRefName) return;
    let live = true;
    void window.deck.gh.prStack(repo, headRefName ?? "", baseRefName ?? "", number)
      .then((resolved) => { if (live) setStack(resolved); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [repo, number, headRefName, baseRefName]);

  if (!stack || (stack.below.length === 0 && stack.above.length === 0)) return null;
  const position = stack.below.length + 1;
  const total = position + stack.above.length;

  return (
    <span ref={popup} className="relative flex items-center text-[12px]">
      <button onClick={() => setOpen((was) => !was)} aria-expanded={open}
        title={`Part of a stack: ${position} of ${total}`}
        className="flex h-6 items-center gap-1.5 rounded-full border border-edge2 px-2 font-mono text-[11px] text-body hover:border-edge3 hover:text-ink">
        <Icon name="layers" size={11} className="text-mut" />{position}/{total}
      </button>
      {open && (
        <div className="absolute left-0 top-6 z-50 flex w-[320px] flex-col gap-0.5 rounded-lg border border-edge3 bg-overlay p-2 shadow-xl">
          <span className="px-1.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-mut">STACK · {total} PULL REQUESTS</span>
          {[...stack.above].reverse().map((pr) => <Entry key={pr.number} repo={repo} pr={pr} />)}
          <span className="flex min-w-0 items-center gap-1 rounded bg-card2 px-1.5 py-0.5">
            <span className="shrink-0 font-mono text-mut">#{number}</span>
            <span className="min-w-0 flex-1 truncate text-ink">{title}</span>
          </span>
          {stack.below.map((pr) => <Entry key={pr.number} repo={repo} pr={pr} />)}
        </div>
      )}
    </span>
  );
}
