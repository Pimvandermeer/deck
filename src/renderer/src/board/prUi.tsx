import type { PrCheck } from "../../../main/github.js";
import { ballFrom, ballText, type ActivityPr, type BallState, type Stance } from "../../../shared/activity.js";
import { prKey } from "../../../shared/prs.js";

const extColors: Record<string, string> = {
  ts: "text-blue",
  tsx: "text-blue",
  js: "text-orange",
  jsx: "text-orange",
  mjs: "text-orange",
  css: "text-accent",
  scss: "text-accent",
  json: "text-green",
  md: "text-mut",
  yml: "text-red",
  yaml: "text-red",
  dart: "text-blue",
  py: "text-green",
  sql: "text-orange",
};

/** File-type badge the way editors do it: the extension, coloured by language. */
export function ExtBadge({ path }: { path: string }) {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  return (
    <span
      className={`inline-block w-7 shrink-0 rounded bg-card2 px-1 text-center text-[8px] font-bold leading-4 ${
        extColors[ext] ?? "text-dim"
      }`}
    >
      {ext.slice(0, 4) || "·"}
    </span>
  );
}

export function FileName({ path, className = "" }: { path: string; className?: string }) {
  const slash = path.lastIndexOf("/");
  const name = slash < 0 ? path : path.slice(slash + 1);
  const dir = slash < 0 ? "" : path.slice(0, slash);
  return (
    <span className={`flex min-w-0 items-baseline gap-2 ${className}`}>
      <span className="shrink-0 font-sans text-[12px] font-semibold text-ink">{name}</span>
      {dir && <span className="truncate font-sans text-[11px] text-dim">{dir}</span>}
    </span>
  );
}

export function Stat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 whitespace-nowrap text-[11px]">
      {additions > 0 && <span className="text-green">+{additions}</span>}
      {additions > 0 && deletions > 0 && " "}
      {deletions > 0 && <span className="text-red">−{deletions}</span>}
      {additions === 0 && deletions === 0 && <span className="text-dim">±0</span>}
    </span>
  );
}

export type CheckTone = "pass" | "fail" | "pending" | "skip";

export const checkTone = (state: string): CheckTone =>
  /success|pass/i.test(state)
    ? "pass"
    : /fail|error|cancel|timed_out|action_required|startup_failure/i.test(state)
      ? "fail"
      : /skip|neutral/i.test(state)
        ? "skip"
        : "pending";

export const toneColor: Record<CheckTone, string> = {
  pass: "text-green",
  fail: "text-red",
  pending: "text-orange",
  skip: "text-dim",
};

/** One line for the sidebar: the worst state wins, the way GitHub's rollup does. */
export function checksSummary(checks: PrCheck[]): { label: string; tone: CheckTone } {
  if (checks.length === 0) return { label: "No checks", tone: "skip" };
  const tones = checks.map((c) => checkTone(c.state));
  const failing = tones.filter((t) => t === "fail").length;
  if (failing > 0) return { label: `${failing} failing`, tone: "fail" };
  const pending = tones.filter((t) => t === "pending").length;
  if (pending > 0) return { label: `${pending} in progress`, tone: "pending" };
  return { label: "All passed", tone: "pass" };
}

const avatarColors = ["#f87171", "#4ade80", "#38bdf8", "#a78bfa", "#fb923c", "#7dcfff"];

export function Avatar({ name, size = 18 }: { name: string; size?: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
  const letters = name
    .replace(/\[bot\]$/i, "")
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-sans font-bold text-bg"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.45),
        background: avatarColors[h % avatarColors.length],
      }}
      title={name}
    >
      {letters || "?"}
    </span>
  );
}

export const relativeTime = (iso: string): string => {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
};

/** Wraps a shell argument in single quotes so code snippets survive `sh -c`. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface Move { label: string; tone: string; strong?: boolean; hint: string }

export const tones = {
  blue: "bg-blue/10 text-blue",
  orange: "bg-orange/10 text-orange",
  green: "bg-green/10 text-green",
  accent: "bg-accent/10 text-accent",
  dim: "bg-card2 text-mut",
};

const stanceTone: Record<Stance, string> = { you: tones.orange, them: tones.blue, others: tones.dim, done: tones.accent };

/** Whose move it is on one PR, from the user's side of it. */
export function moveOf(pr: ActivityPr, viewer: string, requested: Set<string>): Move & { state: BallState } {
  const state = ballFrom(pr, viewer, requested.has(prKey(pr)));
  const since = `since ${relativeTime(state.since)}`;
  if (pr.state === "MERGED") return { state, label: "Merged", tone: tones.accent, hint: pr.mergedAt ? `Merged ${relativeTime(pr.mergedAt)}` : "Merged" };
  if (pr.state === "CLOSED") return { state, label: "Closed", tone: tones.dim, hint: "Closed without merging" };
  const label = ballText(state);
  const tone = state.stance === "you" && state.action === "merge" ? tones.green : stanceTone[state.stance];
  return { state, label, tone, strong: state.stance === "you", hint: `${label} · ${since}` };
}

/** Whose move it is as a pill, the same on the activity page and the reviews rail. */
export function MovePill({ move }: { move: Move }) {
  return <span title={move.hint} className={`inline-flex h-[18px] max-w-full shrink-0 items-center truncate rounded-full px-2 text-[10px] ${move.tone} ${move.strong ? "font-bold" : ""}`}>{move.label}</span>;
}
