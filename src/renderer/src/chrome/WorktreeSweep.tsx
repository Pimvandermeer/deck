import { useCallback, useEffect, useState } from "react";
import type { LinkedWorktree } from "../../../main/worktrees.js";
import { Icon } from "../board/icons.js";

// The close prompt only fires for tabs closed from here on, and never for a
// "close all". So worktrees still pile up, and this is where they surface:
// every linked worktree under the repo roots, biggest first, with the merged
// and clean ones offered together as the safe ones to reclaim.

function size(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function WorktreeSweep({ onClose }: { onClose: () => void }) {
  const [worktrees, setWorktrees] = useState<LinkedWorktree[]>();
  const [busy, setBusy] = useState<string[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(() => window.deck.worktrees.list().then(setWorktrees, () => setWorktrees([])), []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const remove = async (targets: LinkedWorktree[], deleteBranch: boolean) => {
    setBusy(targets.map((worktree) => worktree.path));
    setError("");
    const failures: string[] = [];
    for (const worktree of targets) {
      const result = await window.deck.worktrees.remove(worktree.path, deleteBranch);
      if (!result.removed) failures.push(`${worktree.repo}/${worktree.branch}: ${result.error ?? "failed"}`);
    }
    setBusy([]);
    setError(failures.join("\n"));
    await load();
  };

  // Merged and clean: nothing in these exists only here.
  const safe = worktrees?.filter((worktree) => worktree.merged && !worktree.dirtyFiles) ?? [];
  const reclaimable = safe.reduce((sum, worktree) => sum + worktree.size, 0);

  return <div role="dialog" aria-label="Worktrees" className="view-enter absolute inset-0 z-50 flex flex-col bg-panel">
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3">
      <Icon name="layers" size={12} className="text-mut" />
      <span className="min-w-0 flex-1 truncate text-[12px] text-soft">Worktrees</span>
      <button disabled={!worktrees} onClick={() => { setWorktrees(undefined); void load(); }}
        className="shrink-0 text-[11px] text-dim hover:text-ink disabled:opacity-40">↻ rescan</button>
      <button aria-label="Close worktrees" title="Close" onClick={onClose}
        className="text-mut hover:text-ink"><Icon name="x" size={12} /></button>
    </div>

    {safe.length > 1 && <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
      <span className="min-w-0 flex-1 text-[11px] text-mut">{safe.length} merged and clean · {size(reclaimable)}</span>
      <button disabled={busy.length > 0} onClick={() => void remove(safe, false)}
        className="shrink-0 rounded-md border border-edge3 px-2 py-1 text-[11px] text-soft hover:bg-card disabled:opacity-40">
        Remove all
      </button>
    </div>}

    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
      {!worktrees && <div className="p-4 text-xs text-dim">Scanning repositories…</div>}
      {worktrees?.length === 0 && <div className="p-4 text-xs text-dim">No worktrees outside the main checkouts.</div>}
      {worktrees?.map((worktree) => {
        const working = busy.includes(worktree.path);
        return <div key={worktree.path} className="border-b border-edge/80 px-3 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-soft" title={worktree.path}>{worktree.branch || "detached HEAD"}</span>
              <span className="mt-0.5 block truncate text-[11px] text-dim">{worktree.repo} · {size(worktree.size)}</span>
            </span>
            {working && <span className="shrink-0 text-[11px] text-dim">removing…</span>}
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[11px]">
            <span className={worktree.merged ? "text-dim" : "text-orange"}>
              {worktree.merged ? "merged" : "not on the default branch"}
            </span>
            {worktree.dirtyFiles > 0 && <span className="text-orange">{worktree.dirtyFiles} uncommitted</span>}
            <button disabled={working} onClick={() => void remove([worktree], false)}
              className="ml-auto shrink-0 rounded border border-edge3 px-1.5 py-0.5 text-soft hover:bg-card disabled:opacity-40">
              Remove
            </button>
            <button disabled={working || !worktree.branch} onClick={() => void remove([worktree], true)}
              title={worktree.branch ? `Also delete ${worktree.branch}` : "Detached HEAD has no branch to delete"}
              className="shrink-0 rounded border border-red/40 px-1.5 py-0.5 text-red hover:bg-red/10 disabled:opacity-40">
              + branch
            </button>
          </div>
        </div>;
      })}
      {error && <pre className="whitespace-pre-wrap px-3 py-2 text-[11px] text-red">{error}</pre>}
    </div>
  </div>;
}
