import type { ReactNode } from "react";
import type { IssuePr, PrComment, PrDetail, PrTimelineEvent } from "../../../main/github.js";
import type { BoardIssue } from "../../../main/board/types.js";
import { agentLabels } from "../../../shared/agents.js";
import type { LinkedAgent } from "../../../shared/agentLinks.js";
import { useMemo } from "react";
import { Icon, type IconName } from "./icons.js";
import { Markdown } from "./Markdown.js";
import { TextBox, ThreadCard, threadsOf, type ThreadActions } from "./PrComments.js";
import { Avatar, checksSummary, checkTone, ExtBadge, FileName, relativeTime, Stat, toneColor, type CheckTone } from "./prUi.js";

/** Files grouped by the folder they sit in; tests get their own group. */
function groupFiles<T extends { path: string }>(files: T[]): { name: string; files: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const name = /(^|[./_-])(test|spec|__tests__)([./_-]|$)/i.test(file.path)
      ? "Tests"
      : (file.path.split("/").slice(-2, -1)[0] ?? "root").replace(/^\w/, (c) => c.toUpperCase());
    groups.set(name, [...(groups.get(name) ?? []), file]);
  }
  return [...groups].map(([name, files]) => ({ name, files }));
}

const reviewerGlyph: Record<string, { icon: IconName; color: string; label: string }> = {
  APPROVED: { icon: "check", color: "text-green", label: "approved" },
  CHANGES_REQUESTED: { icon: "x", color: "text-red", label: "requested changes" },
  COMMENTED: { icon: "comment", color: "text-mut", label: "commented" },
  DISMISSED: { icon: "minus", color: "text-dim", label: "dismissed" },
  PENDING: { icon: "circle", color: "text-dim", label: "requested" },
};

const timelineRow = (
  e: PrTimelineEvent,
): { text: string; icon?: IconName; color?: string } => {
  const n = Number(e.detail);
  switch (e.kind) {
    case "opened":
      return { text: "opened this pull request", icon: "branch", color: "text-green" };
    case "commits":
      return { text: `pushed ${n} commit${n === 1 ? "" : "s"}`, icon: "commits" };
    case "force_pushed":
      return { text: "force-pushed the branch", icon: "commits", color: "text-orange" };
    case "review_requested":
      return { text: `requested a review from ${e.detail}`, icon: "circle" };
    case "reviewed":
      return e.detail === "APPROVED"
        ? { text: "approved", icon: "check", color: "text-green" }
        : e.detail === "CHANGES_REQUESTED"
          ? { text: "requested changes", icon: "x", color: "text-red" }
          : { text: "dismissed a review", icon: "minus" };
    case "ready_for_review":
      return { text: "marked as ready for review", icon: "circle" };
    case "auto_merge_enabled":
      return { text: "enabled auto-merge", icon: "play" };
    case "auto_merge_disabled":
      return { text: "disabled auto-merge", icon: "play" };
    case "merged":
      return { text: "merged this pull request", icon: "branch", color: "text-soft" };
    case "closed":
      return { text: "closed this pull request", icon: "x", color: "text-red" };
    case "reopened":
      return { text: "reopened this pull request", icon: "branch", color: "text-green" };
  }
};

// Running is a ring so it never reads as a verdict.
const dotTone: Record<CheckTone, string> = {
  pass: "bg-green",
  fail: "bg-red",
  pending: "border-[1.5px] border-orange",
  skip: "bg-edge3",
};

/** CI at a glance, the same dot on the PR screen and the reviews rail. */
export function CheckDot({ tone, label }: { tone: CheckTone; label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      title={label}
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${dotTone[tone]}`}
    />
  );
}

// mergeStateStatus is what GitHub's merge box keys on; these are its words.
const branchLabel = (detail: PrDetail): { label: string; color: string } => {
  switch (detail.mergeStateStatus) {
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE":
    case "BLOCKED":
      return { label: `Up to date with ${detail.baseRefName}`, color: "text-soft" };
    case "BEHIND":
      return { label: `Behind ${detail.baseRefName}`, color: "text-soft" };
    case "DIRTY":
      return { label: `Conflicts with ${detail.baseRefName}`, color: "text-red" };
    case "DRAFT":
      return { label: "Draft", color: "text-mut" };
    default:
      return { label: "Checking…", color: "text-mut" };
  }
};

const statusLabel = (detail: PrDetail): string =>
  detail.state === "MERGED"
    ? "Merged"
    : detail.state === "CLOSED"
      ? "Closed"
      : detail.isDraft
        ? "Draft"
        : detail.reviewers.length === 0
          ? "Open · no reviews yet"
          : "Open";

function Label({ children }: { children: ReactNode }) {
  return <div className="pb-2.5 text-[11px] font-semibold tracking-[0.06em] text-mut">{children}</div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pb-6">
      <Label>{title}</Label>
      {children}
    </div>
  );
}

/** One label/value line of the details card. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-card2 px-3.5 py-3 last:border-b-0">
      <span className="shrink-0 text-mut">{label}</span>
      <div className="flex min-w-0 flex-col items-end gap-1 text-right text-soft">{children}</div>
    </div>
  );
}

export interface PrOverviewProps {
  pr: IssuePr;
  detail: PrDetail | null | undefined;
  issue?: BoardIssue;
  generalComments: PrComment[];
  timeline: PrTimelineEvent[];
  commentsByPath: Map<string, PrComment[]>;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
  onOpenFile: (path: string) => void;
  threadActions: ThreadActions;
  onComment: (body: string) => Promise<boolean>;
  /** The agent that paused for the user's review, with its note. */
  paused?: LinkedAgent;
}

export function PrOverview({
  pr,
  detail,
  issue,
  generalComments,
  timeline,
  commentsByPath,
  viewed,
  onToggleViewed,
  onOpenFile,
  threadActions,
  onComment,
  paused,
}: PrOverviewProps) {
  const checks = detail ? checksSummary(detail.checks) : undefined;
  const groups = useMemo(() => groupFiles(detail?.files ?? []), [detail]);
  const status = detail && statusLabel(detail);
  const branch = detail && branchLabel(detail);

  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto">
      <div className="flex w-full max-w-[1400px] gap-8 px-6 pb-10 pt-7">
        <div className="min-w-0 flex-1">
          <Label>DESCRIPTION</Label>
          {detail === null ? (
            <div className="text-[12px] text-red">Could not load this PR through gh.</div>
          ) : detail === undefined ? (
            <div className="text-[12px] text-mut">loading…</div>
          ) : (
            // The .md rules in index.css sit outside Tailwind's layers, so size and code face need !.
            <div className="pr-overview-body max-w-[720px]">
              {detail.body.trim() ? (
                <Markdown>{detail.body}</Markdown>
              ) : (
                <div className="text-[13px] italic text-mut">No description.</div>
              )}
            </div>
          )}
          {paused?.link.reviewNote && (
            <div className="mt-5 flex max-w-[720px] flex-col gap-2 rounded-[10px] border border-accent/20 bg-accent/10 px-4 py-3.5">
              <span className="flex items-center gap-2 text-[12px] font-semibold text-accent">
                <Icon name="sparkle" size={13} />
                {agentLabels[paused.link.agent]} paused for your review
              </span>
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-soft">{paused.link.reviewNote}</p>
            </div>
          )}

          {detail && (
            <>
              <div className="mt-10"><Label>ACTIVITY</Label></div>
              <div className="font-sans text-[12px] text-mut">
                {timeline.length === 0 && <div className="py-1 text-dim">loading…</div>}
                {timeline.map((e, i) => {
                  const row = timelineRow(e);
                  return (
                    <div key={i} className="flex items-center gap-2 py-1">
                      <Avatar name={e.actor || "?"} size={16} />
                      <span>
                        <span className="text-soft">{e.actor}</span> {row.text}
                      </span>
                      {row.icon && <Icon name={row.icon} size={11} className={row.color ?? "text-dim"} />}
                      {e.date && <span className="text-dim">· {relativeTime(e.date)}</span>}
                    </div>
                  );
                })}
              </div>
              <div className="-mx-2 mt-2">
                {threadsOf(generalComments).map((thread) => (
                  <ThreadCard key={thread[0].id} comments={thread} actions={threadActions} />
                ))}
                <div className="mx-2 my-1.5 rounded-lg border border-edge2 bg-card px-3 py-2">
                  <TextBox placeholder="Leave a comment…" sendLabel="Comment" onSend={onComment} />
                </div>
              </div>
            </>
          )}
        </div>

        <aside aria-label="Pull request details" className="flex w-[300px] shrink-0 flex-col gap-6 text-[13px]">
          <div className="flex flex-col overflow-hidden rounded-xl border border-edge">
            <Row label="Status">{status ?? <span className="text-mut">…</span>}</Row>

            <Row label="Resolves">
              {issue && (
                <button onClick={() => window.open(issue.url)} title={issue.summary} className="font-mono text-[12px] hover:text-ink">
                  {issue.key}
                </button>
              )}
              {detail?.linkedIssues.map((li) => (
                <button
                  key={li.url}
                  onClick={() => window.open(li.url)}
                  title={li.title}
                  className="flex max-w-full items-center gap-2 hover:text-ink"
                >
                  <span className="shrink-0 font-mono text-[12px]">#{li.number}</span>
                  <span className="truncate text-body">{li.title}</span>
                </button>
              ))}
              {issue === undefined && detail && detail.linkedIssues.length === 0 && (
                <span className="text-mut">Nothing linked</span>
              )}
            </Row>

            <Row label="Reviewers">
              {detail && detail.reviewers.length === 0 && <span className="text-mut">None yet</span>}
              {detail?.reviewers.map((r) => {
                const g = reviewerGlyph[r.state] ?? reviewerGlyph.COMMENTED;
                const you = r.login === detail.viewer;
                // A review asked of the user is their move.
                const tone = you && r.state === "PENDING" ? "font-semibold text-orange" : g.color;
                return (
                  <span key={r.login} className="flex max-w-full items-center gap-1.5" title={`${r.login} · ${g.label}`}>
                    <Avatar name={r.login} size={16} />
                    <span className="truncate">{you ? "you" : r.login}</span>
                    <span className={`flex shrink-0 items-center gap-1 text-[12px] ${tone}`}>
                      <Icon name={g.icon} size={11} /> {g.label}
                    </span>
                  </span>
                );
              })}
            </Row>

            {checks && (
              <details className="group border-b border-card2 last:border-b-0">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3">
                  <span className="text-mut">Checks</span>
                  <span className="flex items-center gap-1.5 text-soft">
                    <CheckDot tone={checks.tone} />
                    {checks.label}
                    {detail!.checks.length > 0 && (
                      <Icon name="chevronDown" size={11} className="text-mut group-open:rotate-180" />
                    )}
                  </span>
                </summary>
                <div className="flex flex-col gap-0.5 px-2.5 pb-2.5">
                  {detail!.checks.map((c, i) => (
                    <button
                      key={i}
                      onClick={() => c.url && window.open(c.url)}
                      disabled={!c.url}
                      className="flex items-center gap-2 rounded px-1 py-0.5 text-left text-[12px] hover:bg-card disabled:cursor-default"
                    >
                      <Icon name="dot" size={11} className={toneColor[checkTone(c.state)]} />
                      <span className="truncate text-body">{c.name}</span>
                    </button>
                  ))}
                </div>
              </details>
            )}

            <Row label="Branch">
              {branch && <span className={branch.color}>{branch.label}</span>}
              {detail?.mergeable === "CONFLICTING" && (
                <span className="text-[12px] text-red">Merge conflicts must be resolved first.</span>
              )}
              {detail?.autoMerge && (
                <span className="text-[12px]">
                  Auto-merge on <span className="text-mut">({detail.autoMerge.method})</span>
                </span>
              )}
            </Row>
          </div>

          {detail && (
            <Section
              title={`${detail.files.length} FILE${detail.files.length === 1 ? "" : "S"} CHANGED${
                viewed.size > 0 ? ` · ${viewed.size} REVIEWED` : ""
              }`}
            >
              <div className="flex items-center justify-between pb-1 text-[11px]">
                <span className="font-mono text-mut">
                  {detail.commits.length} commit{detail.commits.length === 1 ? "" : "s"}
                </span>
                <Stat additions={detail.additions} deletions={detail.deletions} />
              </div>
              {groups.map((group) => {
                const adds = group.files.reduce((n, f) => n + f.additions, 0);
                const dels = group.files.reduce((n, f) => n + f.deletions, 0);
                return (
                  <div key={group.name} className="pb-2">
                    <div className="flex items-center justify-between py-1 text-[11px]">
                      <span className="text-soft">
                        {group.name} <span className="text-dim">{group.files.length}</span>
                      </span>
                      <Stat additions={adds} deletions={dels} />
                    </div>
                    {group.files.map((f) => {
                      const threads = threadsOf(commentsByPath.get(f.path) ?? []);
                      const open = threads.filter((t) => !t[0].resolved && !t[0].outdated).length;
                      return (
                        <div
                          key={f.path}
                          className={`flex items-center gap-2 rounded px-1 py-1 hover:bg-card ${
                            viewed.has(f.path) ? "opacity-50" : ""
                          }`}
                          title={f.path}
                        >
                          <input
                            type="checkbox"
                            checked={viewed.has(f.path)}
                            onChange={() => onToggleViewed(f.path)}
                            className="h-3 w-3 shrink-0 accent-green"
                            title="Reviewed"
                          />
                          <button
                            onClick={() => onOpenFile(f.path)}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          >
                            <ExtBadge path={f.path} />
                            <FileName path={f.path} className="flex-1" />
                          </button>
                          {threads.length > 0 && (
                            <span
                              className={`flex items-center gap-0.5 font-mono text-[11px] ${open > 0 ? "text-soft" : "text-mut"}`}
                            >
                              <Icon name="comment" size={10} />
                              {open > 0 ? open : threads.length}
                            </span>
                          )}
                          <Stat additions={f.additions} deletions={f.deletions} />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </Section>
          )}
        </aside>
      </div>
    </div>
  );
}
