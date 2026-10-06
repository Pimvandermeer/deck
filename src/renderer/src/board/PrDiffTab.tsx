import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import {
  Decoration,
  Diff,
  getChangeKey,
  getCorrespondingOldLineNumber,
  Hunk,
  insertHunk,
  isDelete,
  markEdits,
  textLinesToHunk,
  tokenize,
  type ChangeData,
  type ChangeEventArgs,
  type FileData,
  type HunkData,
  type HunkTokens,
  type ViewType,
} from "react-diff-view";
import { refractor } from "refractor";
import "react-diff-view/style/index.css";
import type { PrComment, PrDetail } from "../../../main/github.js";
import {
  Composer,
  DraftCard,
  TextBox,
  ThreadCard,
  threadsOf,
  type ComposerTarget,
  type Draft,
  type ThreadActions,
} from "./PrComments.js";
import { Icon } from "./icons.js";
import { ExtBadge, FileName, relativeTime, Stat } from "./prUi.js";
import { useTerminalAppearance } from "../lib/useTerminalAppearance.js";

const EXPAND_STEP = 20;
// Highlighting is synchronous; past this many changes it would freeze the UI.
const HIGHLIGHT_LIMIT = 3000;

const languageByExt: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  css: "css",
  scss: "scss",
  json: "json",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  py: "python",
  dart: "dart",
  sql: "sql",
  sh: "bash",
  zsh: "bash",
  html: "markup",
  xml: "markup",
  svg: "markup",
  go: "go",
  rs: "rust",
  diff: "diff",
};

// react-diff-view predates refractor's hast Root return value and wants the
// bare node list, so this is the one line of adapter.
const highlighter = {
  highlight: (text: string, language: string) => refractor.highlight(text, language).children,
};

const languageFor = (path: string): string | undefined => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const language = languageByExt[ext];
  return language && refractor.registered(language) ? language : undefined;
};

const filePath = (file: FileData) => file.newPath || file.oldPath;

const countChanges = (hunks: HunkData[]) =>
  hunks.reduce((n, hunk) => n + hunk.changes.length, 0);

/**
 * Splices `source` lines (new-side numbering, `end` exclusive) into the hunks.
 * The library's own expandFromRawCode wants the old file, but the head commit
 * is the one ref this diff is pinned to, so the new side is what we fetch.
 */
function expandNewLines(hunks: HunkData[], source: string[], start: number, end: number) {
  const lines = source.slice(Math.max(start, 1) - 1, end - 1);
  if (lines.length === 0) return hunks;
  const hunk = textLinesToHunk(lines, getCorrespondingOldLineNumber(hunks, start), start);
  return hunk ? insertHunk(hunks, hunk) : hunks;
}

function Gap({
  lines,
  onUp,
  onDown,
  onAll,
}: {
  lines: number | null;
  onUp?: () => void;
  onDown?: () => void;
  onAll: () => void;
}) {
  const stepped = lines === null || lines > EXPAND_STEP * 2;
  return (
    <Decoration className="deck-gap">
      <div className="flex items-center justify-center gap-1 text-[11px] text-dim">
        {stepped && onUp && (
          <button onClick={onUp} title={`Expand ${EXPAND_STEP} lines down`} className="rounded px-1.5 hover:bg-card2 hover:text-ink">
            <Icon name="expandDown" size={11} />
          </button>
        )}
        <button onClick={onAll} className="rounded px-2 hover:bg-card2 hover:text-ink">
          <Icon name="expand" size={11} className="mr-1" />
          {lines === null ? "expand to end of file" : `${lines} unchanged line${lines === 1 ? "" : "s"}`}
        </button>
        {stepped && onDown && (
          <button onClick={onDown} title={`Expand ${EXPAND_STEP} lines up`} className="rounded px-1.5 hover:bg-card2 hover:text-ink">
            <Icon name="expandUp" size={11} />
          </button>
        )}
      </div>
    </Decoration>
  );
}

type Side = "LEFT" | "RIGHT";

interface LineSelection {
  side: Side;
  anchor: number;
  focus: number;
}

export interface AskAgentRequest {
  path: string;
  side: Side;
  start: number;
  end: number;
  snippet: string;
  question: string;
}

const lineOn = (change: ChangeData, side: Side): number | undefined =>
  change.type === "normal"
    ? side === "LEFT"
      ? change.oldLineNumber
      : change.newLineNumber
    : (change.type === "delete") === (side === "LEFT")
      ? change.lineNumber
      : undefined;

function SelectionBar({
  start,
  end,
  canComment,
  onComment,
  onAsk,
  onCopy,
  onClear,
}: {
  start: number;
  end: number;
  canComment: boolean;
  onComment: () => void;
  onAsk: (question: string) => void;
  onCopy: () => void;
  onClear: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const label = start === end ? `Line ${start}` : `Lines ${start}–${end}`;
  return (
    <div className="mx-2 my-1.5 max-w-[760px] rounded-lg border border-accent/40 bg-card px-3 py-2 font-sans text-[11px]">
      <div className="flex items-center gap-2">
        <span className="text-soft">{label}</span>
        <span className="text-dim">selected</span>
        <span className="ml-auto flex items-center gap-1.5">
          {canComment && (
            <button
              onClick={onComment}
              className="rounded-md border border-edge2 px-2 py-0.5 text-body hover:border-edge3 hover:text-ink"
            >
              <Icon name="comment" size={11} /> Comment
            </button>
          )}
          <button
            onClick={() => setAsking((a) => !a)}
            className={`rounded-md border px-2 py-0.5 ${
              asking ? "border-accent text-accent" : "border-edge2 text-body hover:border-edge3 hover:text-ink"
            }`}
          >
            <Icon name="sparkle" size={11} /> Ask agent
          </button>
          <button
            onClick={onCopy}
            className="rounded-md border border-edge2 px-2 py-0.5 text-body hover:border-edge3 hover:text-ink"
          >
            Copy
          </button>
          <button onClick={onClear} className="px-1 text-dim hover:text-ink" title="Clear selection (esc)">
            <Icon name="x" size={11} />
          </button>
        </span>
      </div>
      {asking && (
        <div className="mt-2">
          <TextBox
            placeholder="What do you want to know or change about these lines?"
            sendLabel="Open in agent"
            autoFocus
            onCancel={() => setAsking(false)}
            onSend={(question) => onAsk(question)}
          />
        </div>
      )}
    </div>
  );
}

interface FileDiffProps {
  file: FileData;
  viewType: ViewType;
  viewed: boolean;
  collapsed: boolean;
  active: boolean;
  canComment: boolean;
  comments: PrComment[];
  drafts: Draft[];
  composer: ComposerTarget | null;
  threadActions: ThreadActions;
  loadSource: () => Promise<string[] | null>;
  githubUrl: string;
  onAskAgent: (request: AskAgentRequest) => void;
  onToggleViewed: () => void;
  onToggleCollapsed: () => void;
  onOpenComposer: (target: ComposerTarget, extend: boolean) => void;
  onCancelComposer: () => void;
  onSaveDraft: (body: string) => void;
  onDeleteDraft: (id: number) => void;
}

function FileDiff({
  file,
  viewType,
  viewed,
  collapsed,
  active,
  canComment,
  comments,
  drafts,
  composer,
  threadActions,
  loadSource,
  githubUrl,
  onAskAgent,
  onToggleViewed,
  onToggleCollapsed,
  onOpenComposer,
  onCancelComposer,
  onSaveDraft,
  onDeleteDraft,
}: FileDiffProps) {
  const path = filePath(file);
  const [hunks, setHunks] = useState(file.hunks);
  const source = useRef<string[] | null>();
  useEffect(() => setHunks(file.hunks), [file]);

  // GitHub-style range selection: click a line number, drag or shift-click to
  // another. Everything in between lights up and a bar offers what to do with it.
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const dragging = useRef(false);
  useEffect(() => {
    if (!selection) return;
    const stop = () => (dragging.current = false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setSelection(null);
    };
    window.addEventListener("mouseup", stop);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("keydown", onKey);
    };
  }, [selection]);
  useEffect(() => {
    if (composer) setSelection(null);
  }, [composer]);

  const sideOf = (change: ChangeData, gutter: "old" | "new" | undefined): Side =>
    isDelete(change) || gutter === "old" ? "LEFT" : "RIGHT";

  const gutterEvents = {
    onMouseDown: ({ change, side }: ChangeEventArgs, e: React.MouseEvent) => {
      if (!change || e.button !== 0 || (e.target as HTMLElement).tagName === "BUTTON") return;
      e.preventDefault();
      const s = sideOf(change, side);
      const line = lineOn(change, s);
      if (line === undefined) return;
      dragging.current = true;
      setSelection((prev) =>
        e.shiftKey && prev && prev.side === s ? { ...prev, focus: line } : { side: s, anchor: line, focus: line },
      );
    },
    onMouseEnter: ({ change, side }: ChangeEventArgs) => {
      if (!dragging.current || !change) return;
      setSelection((prev) => {
        if (!prev) return prev;
        const line = lineOn(change, sideOf(change, side));
        return line === undefined || line === prev.focus ? prev : { ...prev, focus: line };
      });
    },
  };

  const selected = useMemo(() => {
    if (!selection) return { keys: [] as string[], lastKey: undefined as string | undefined, text: "" };
    const start = Math.min(selection.anchor, selection.focus);
    const end = Math.max(selection.anchor, selection.focus);
    const keys: string[] = [];
    const lines: string[] = [];
    let lastKey: string | undefined;
    for (const hunk of hunks)
      for (const change of hunk.changes) {
        const line = lineOn(change, selection.side);
        if (line === undefined || line < start || line > end) continue;
        keys.push(getChangeKey(change));
        lines.push(change.content);
        lastKey = getChangeKey(change);
      }
    return { keys, lastKey, text: lines.join("\n"), start, end };
  }, [selection, hunks]);

  const additions = file.hunks.reduce(
    (n, h) => n + h.changes.filter((c) => c.type === "insert").length,
    0,
  );
  const deletions = file.hunks.reduce(
    (n, h) => n + h.changes.filter((c) => c.type === "delete").length,
    0,
  );

  const tokens = useMemo<HunkTokens | undefined>(() => {
    if (collapsed || countChanges(hunks) > HIGHLIGHT_LIMIT) return undefined;
    const language = languageFor(path);
    try {
      return tokenize(hunks, {
        ...(language
          ? ({ highlight: true, refractor: highlighter, language } as const)
          : { highlight: false }),
        enhancers: [markEdits(hunks, { type: "block" })],
      });
    } catch {
      return undefined;
    }
  }, [hunks, path, collapsed]);

  // Anchor everything to its diff line, Linear-style: existing threads, local
  // drafts, and the open composer. Threads whose line no longer exists in the
  // diff (outdated code) fall back to a block on top of the file.
  const { widgets, unanchored } = useMemo(() => {
    const widgets: Record<string, ReactNode> = {};
    const unanchored: PrComment[] = [];
    const newSide = new Map<number, string>();
    const oldSide = new Map<number, string>();
    for (const hunk of hunks)
      for (const change of hunk.changes) {
        const key = getChangeKey(change);
        if (change.type === "insert") newSide.set(change.lineNumber, key);
        else if (change.type === "delete") oldSide.set(change.lineNumber, key);
        else {
          newSide.set(change.newLineNumber, key);
          oldSide.set(change.oldLineNumber, key);
        }
      }

    const parts = new Map<string, ReactNode[]>();
    const push = (key: string, node: ReactNode) =>
      parts.set(key, [...(parts.get(key) ?? []), node]);

    for (const thread of threadsOf(comments)) {
      const first = thread[0];
      const key = first.line == null ? undefined : newSide.get(first.line);
      if (key) push(key, <ThreadCard key={`t${first.id}`} comments={thread} actions={threadActions} />);
      else unanchored.push(...thread);
    }
    for (const draft of drafts) {
      const key = (draft.side === "LEFT" ? oldSide : newSide).get(draft.line);
      if (key)
        push(
          key,
          <DraftCard key={`d${draft.id}`} draft={draft} onDelete={() => onDeleteDraft(draft.id)} />,
        );
    }
    if (composer) {
      const key = (composer.side === "LEFT" ? oldSide : newSide).get(composer.line);
      if (key)
        push(
          key,
          <Composer key="composer" target={composer} onCancel={onCancelComposer} onSave={onSaveDraft} />,
        );
    }
    if (selection && selected.lastKey && selected.start !== undefined && selected.end !== undefined) {
      const { side } = selection;
      const { start, end, text } = selected;
      push(
        selected.lastKey,
        <SelectionBar
          key="selection"
          start={start}
          end={end}
          canComment={canComment}
          onComment={() => onOpenComposer({ path, line: end, side, startLine: start }, false)}
          onAsk={(question) => {
            onAskAgent({ path, side, start, end, snippet: text, question });
            setSelection(null);
          }}
          onCopy={() => void navigator.clipboard.writeText(text)}
          onClear={() => setSelection(null)}
        />,
      );
    }
    for (const [key, nodes] of parts) widgets[key] = <div className="max-w-[760px] py-1">{nodes}</div>;
    return { widgets, unanchored };
  }, [
    hunks,
    comments,
    drafts,
    composer,
    selection,
    selected,
    canComment,
    path,
    threadActions,
    onOpenComposer,
    onAskAgent,
    onCancelComposer,
    onSaveDraft,
    onDeleteDraft,
  ]);

  const renderGutter = ({
    change,
    side,
    inHoverState,
    renderDefault,
    wrapInAnchor,
  }: {
    change: ChangeData;
    side: "old" | "new";
    inHoverState: boolean;
    renderDefault: () => ReactNode;
    wrapInAnchor: (element: ReactNode) => ReactNode;
  }) => {
    const gutter = wrapInAnchor(renderDefault());
    if (!inHoverState || !canComment || dragging.current) return gutter;
    // A removed line only exists on the left, so that is the side to comment on.
    const commentSide = sideOf(change, side);
    const line = lineOn(change, commentSide);
    if (line === undefined) return gutter;
    return (
      <>
        {gutter}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenComposer({ path, line, side: commentSide }, e.shiftKey);
          }}
          title="Comment on this line — drag over line numbers for a range"
          className="absolute ml-0.5 rounded bg-accent px-1 text-[11px] font-bold text-bg"
        >
          +
        </button>
      </>
    );
  };

  const expand = async (start: number, end: number | null) => {
    if (source.current === undefined) source.current = await loadSource();
    const lines = source.current;
    if (!lines) return;
    setHunks((current) => expandNewLines(current, lines, start, end ?? lines.length + 1));
  };

  const expandable = file.type !== "delete" && file.hunks.length > 0;
  const lastHunk = hunks[hunks.length - 1];
  const lastEnd = lastHunk ? lastHunk.newStart + lastHunk.newLines : 1;
  const trailing =
    expandable &&
    (source.current === undefined || (source.current !== null && source.current.length >= lastEnd));

  return (
    <div
      id={`pr-file-${path}`}
      className={`mx-5 my-2 overflow-hidden rounded-lg border border-edge bg-panel ${
        active ? "deck-file-active" : ""
      } ${viewed && collapsed ? "opacity-60" : ""}`}
    >
      <div
        className={`sticky top-0 z-10 flex items-center gap-2 bg-panel/95 px-3 py-2 backdrop-blur ${
          collapsed ? "" : "border-b border-edge"
        }`}
      >
        <button
          onClick={onToggleCollapsed}
          className="w-4 text-[11px] text-dim hover:text-ink"
          title={collapsed ? "Expand file" : "Collapse file"}
        >
          <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={11} />
        </button>
        <ExtBadge path={path} />
        <FileName path={path} className="min-w-0 flex-1" />
        {file.type === "rename" && (
          <span className="truncate font-sans text-[11px] text-dim">renamed from {file.oldPath}</span>
        )}
        {file.type === "add" && <span className="rounded bg-green/15 px-1 text-[10px] text-green">new</span>}
        {file.type === "delete" && <span className="rounded bg-red/15 px-1 text-[10px] text-red">deleted</span>}
        {comments.length > 0 && (
          <span
            className={`rounded px-1.5 text-[11px] ${
              comments.some((c) => !c.resolved && !c.outdated) ? "bg-orange/15 text-orange" : "bg-card2 text-dim"
            }`}
            title="Review comments on this file"
          >
            <Icon name="comment" size={10} /> {threadsOf(comments).length}
          </span>
        )}
        {drafts.length > 0 && (
          <span className="rounded bg-accent/15 px-1.5 text-[11px] text-accent">
            <Icon name="pencil" size={10} /> {drafts.length}
          </span>
        )}
        <Stat additions={additions} deletions={deletions} />
        <label
          className={`ml-2 flex cursor-pointer select-none items-center gap-1.5 rounded px-1.5 py-0.5 font-sans text-[11px] hover:bg-card2 ${
            viewed ? "text-green" : "text-mut"
          }`}
          title="Mark reviewed (v) — synced with GitHub's Viewed checkbox"
        >
          <input
            type="checkbox"
            checked={viewed}
            onChange={onToggleViewed}
            className="h-3 w-3 accent-green"
          />
          Reviewed
          {active && <kbd className="rounded border border-edge2 px-1 text-[10px] text-dim">v</kbd>}
        </label>
        <button
          onClick={() => window.open(githubUrl)}
          className="text-[11px] text-dim hover:text-ink"
          title="Open on GitHub"
        >
          <Icon name="external" size={12} />
        </button>
      </div>
      {!collapsed && (
        <>
          {unanchored.length > 0 && (
            <div className="max-w-[760px] border-b border-edge py-1">
              {threadsOf(unanchored).map((thread) => (
                <ThreadCard key={thread[0].id} comments={thread} actions={threadActions} />
              ))}
            </div>
          )}
          {file.hunks.length === 0 ? (
            <div className="px-4 py-3 font-sans text-[11px] italic text-dim">
              {file.type === "rename" ? "Renamed without changes." : "No textual changes (binary or mode change)."}
            </div>
          ) : (
            <Diff
              viewType={viewType}
              diffType={file.type}
              hunks={hunks}
              widgets={widgets}
              tokens={tokens}
              renderGutter={renderGutter}
              gutterEvents={gutterEvents}
              selectedChanges={selected.keys}
            >
              {(hunks) => [
                ...hunks.flatMap((hunk, i) => {
                  const prev = hunks[i - 1];
                  const start = prev ? prev.newStart + prev.newLines : 1;
                  const gap = hunk.newStart - start;
                  const nodes: ReactElement[] = [];
                  if (expandable && gap > 0)
                    nodes.push(
                      <Gap
                        key={`gap${hunk.content}`}
                        lines={gap}
                        onUp={prev ? () => void expand(start, Math.min(start + EXPAND_STEP, hunk.newStart)) : undefined}
                        onDown={() => void expand(Math.max(hunk.newStart - EXPAND_STEP, start), hunk.newStart)}
                        onAll={() => void expand(start, hunk.newStart)}
                      />,
                    );
                  nodes.push(<Hunk key={hunk.content} hunk={hunk} />);
                  return nodes;
                }),
                ...(trailing
                  ? [
                      <Gap
                        key="gap-end"
                        lines={source.current ? source.current.length - lastEnd + 1 : null}
                        onUp={() => void expand(lastEnd, lastEnd + EXPAND_STEP)}
                        onAll={() => void expand(lastEnd, null)}
                      />,
                    ]
                  : []),
              ]}
            </Diff>
          )}
        </>
      )}
    </div>
  );
}

export interface PrDiffTabProps {
  repo: string;
  detail: PrDetail | null | undefined;
  files: FileData[];
  diffText: string | undefined;
  viewType: ViewType;
  onViewType: (v: ViewType) => void;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
  activePath: string | undefined;
  onActivate: (path: string) => void;
  canComment: boolean;
  commentsByPath: Map<string, PrComment[]>;
  drafts: Draft[];
  composer: ComposerTarget | null;
  onOpenComposer: (target: ComposerTarget, extend: boolean) => void;
  onCancelComposer: () => void;
  onSaveDraft: (body: string) => void;
  onDeleteDraft: (id: number) => void;
  threadActions: ThreadActions;
  onAskAgent: (request: AskAgentRequest) => void;
}

export function PrDiffTab(props: PrDiffTabProps) {
  const { repo, detail, files, diffText, viewType, viewed, activePath } = props;
  // Code reads at the same size in the diff as in the terminal.
  const { fontSize } = useTerminalAppearance();
  const [subTab, setSubTab] = useState<"files" | "commits">("files");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(viewed));
  const sources = useRef(new Map<string, Promise<string[] | null>>());
  const scrollRef = useRef<HTMLDivElement>(null);

  // A file marked reviewed folds away, the way GitHub does; unmarking reopens it.
  const viewedBefore = useRef(viewed);
  useEffect(() => {
    const before = viewedBefore.current;
    viewedBefore.current = viewed;
    setCollapsed((c) => {
      const next = new Set(c);
      for (const path of viewed) if (!before.has(path)) next.add(path);
      for (const path of before) if (!viewed.has(path)) next.delete(path);
      return next;
    });
  }, [viewed]);

  useEffect(() => {
    if (!activePath || subTab !== "files") return;
    document.getElementById(`pr-file-${activePath}`)?.scrollIntoView({ block: "start" });
  }, [activePath, subTab]);

  const loadSource = (path: string) => () => {
    if (!detail) return Promise.resolve(null);
    let pending = sources.current.get(path);
    if (!pending) {
      pending = window.deck.gh
        .fileContent(repo, detail.headRefOid, path)
        .then((text) => (text === null ? null : text.replace(/\n$/, "").split("\n")));
      sources.current.set(path, pending);
    }
    return pending;
  };

  const reviewedCount = files.filter((f) => viewed.has(filePath(f))).length;
  const commits = detail?.commits ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-edge px-3 py-1.5 font-sans text-[12px]">
        {(["files", "commits"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setSubTab(tab)}
            className={`rounded-md px-2.5 py-1 ${
              subTab === tab ? "bg-card2 text-ink" : "text-mut hover:text-ink"
            }`}
          >
            <Icon name={tab === "files" ? "list" : "commits"} size={11} className="mr-1" />
            {tab === "files" ? "Files" : "Commits"}{" "}
            <span className="text-dim">{tab === "files" ? files.length : commits.length}</span>
          </button>
        ))}
        <span className="ml-auto text-[11px] text-dim">
          {files.length > 0 && `${reviewedCount}/${files.length} reviewed`}
        </span>
        <div className="ml-2 flex overflow-hidden rounded-md border border-edge2 text-[11px]">
          {(["unified", "split"] as const).map((v) => (
            <button
              key={v}
              onClick={() => props.onViewType(v)}
              className={`px-2 py-0.5 ${viewType === v ? "bg-card2 text-ink" : "text-dim hover:text-ink"}`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {subTab === "commits" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {commits.length === 0 && <div className="text-[11px] text-dim">No commits loaded.</div>}
          {commits.map((c) => (
            <button
              key={c.oid}
              onClick={() => detail && window.open(`${detail.url}/commits/${c.oid}`)}
              className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left hover:bg-card"
            >
              <span className="shrink-0 text-[11px] text-accent">{c.oid.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-soft">{c.headline}</span>
              <span className="shrink-0 font-sans text-[11px] text-dim">
                {c.author} · {relativeTime(c.date)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div ref={scrollRef} className="deck-diff min-h-0 flex-1 overflow-auto py-2" style={{ "--diff-font-size": `${fontSize}px` } as CSSProperties}>
          {diffText === undefined && <div className="px-4 py-3 text-[11px] text-dim">loading diff…</div>}
          {diffText?.startsWith("diff unavailable") && (
            <div className="px-4 py-3 text-[11px] text-red">{diffText}</div>
          )}
          {files.map((file) => {
            const path = filePath(file);
            return (
              <div key={path} onMouseDown={() => props.onActivate(path)}>
                <FileDiff
                  file={file}
                  viewType={viewType}
                  viewed={viewed.has(path)}
                  collapsed={collapsed.has(path)}
                  active={path === activePath}
                  canComment={props.canComment}
                  comments={props.commentsByPath.get(path) ?? []}
                  drafts={props.drafts.filter((d) => d.path === path)}
                  composer={props.composer?.path === path ? props.composer : null}
                  threadActions={props.threadActions}
                  onAskAgent={props.onAskAgent}
                  loadSource={loadSource(path)}
                  githubUrl={detail ? `${detail.url}/files#diff-${path}` : `https://github.com/${repo}`}
                  onToggleViewed={() => props.onToggleViewed(path)}
                  onToggleCollapsed={() =>
                    setCollapsed((c) => {
                      const next = new Set(c);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return next;
                    })
                  }
                  onOpenComposer={props.onOpenComposer}
                  onCancelComposer={props.onCancelComposer}
                  onSaveDraft={props.onSaveDraft}
                  onDeleteDraft={props.onDeleteDraft}
                />
              </div>
            );
          })}
          {files.length > 0 && <div className="h-[40vh]" />}
          {diffText && files.length === 0 && !diffText.startsWith("diff unavailable") && (
            <div className="px-4 py-3 text-[11px] text-dim">No changes.</div>
          )}
        </div>
      )}
    </div>
  );
}
