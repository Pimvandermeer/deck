import type { AgentLaunch } from "../../../shared/agents.js";
// Minimal cross-view event bus: lets search (or later, the board) open a
// terminal tab without threading callbacks through the whole tree.

export interface OpenTabDetail extends AgentLaunch {
  cwd?: string;
  command?: string;
  issueKey?: string;
  sessionId?: string;
}

// Mouse/keyboard "back": overlays get first refusal (they call
// preventDefault when they consume it), then the view history moves.
const NAV_BACK = "deck:nav-back";

export function requestNavBack(): boolean {
  return !window.dispatchEvent(new CustomEvent(NAV_BACK, { cancelable: true }));
}

export function onNavBack(cb: (e: Event) => void): () => void {
  window.addEventListener(NAV_BACK, cb);
  return () => window.removeEventListener(NAV_BACK, cb);
}

const OPEN_TAB = "deck:open-tab";

export function openTerminalTab(detail: OpenTabDetail): void {
  window.dispatchEvent(new CustomEvent(OPEN_TAB, { detail }));
}

export function onOpenTerminalTab(cb: (detail: OpenTabDetail) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<OpenTabDetail>).detail);
  window.addEventListener(OPEN_TAB, listener);
  return () => window.removeEventListener(OPEN_TAB, listener);
}

const FOCUS_TERM = "deck:focus-term";

/** Brings an existing terminal tab to the front, never starting a new one. */
export function focusTerminal(termId: string): void {
  window.dispatchEvent(new CustomEvent(FOCUS_TERM, { detail: termId }));
}

export function onFocusTerminal(cb: (termId: string) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<string>).detail);
  window.addEventListener(FOCUS_TERM, listener);
  return () => window.removeEventListener(FOCUS_TERM, listener);
}

const OPEN_PR = "deck:open-pr";

export interface OpenPrDetail {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  updatedAt: string;
  /** The ticket it was opened from, when the PR's title and branch do not name it. */
  issueKey?: string;
}

export function openPullRequest(detail: OpenPrDetail): void {
  window.dispatchEvent(new CustomEvent(OPEN_PR, { detail }));
}

export function onOpenPullRequest(cb: (detail: OpenPrDetail) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<OpenPrDetail>).detail);
  window.addEventListener(OPEN_PR, listener);
  return () => window.removeEventListener(OPEN_PR, listener);
}

const TOGGLE_AGENT = "deck:toggle-agent";

/** Opens or closes deck's agent panel, from the keyboard or a page. */
export function toggleAgentPanel(): void {
  window.dispatchEvent(new CustomEvent(TOGGLE_AGENT));
}

export function onToggleAgentPanel(cb: () => void): () => void {
  window.addEventListener(TOGGLE_AGENT, cb);
  return () => window.removeEventListener(TOGGLE_AGENT, cb);
}

const GO_BACK = "deck:go-back";

/** Steps the page history back, as the mouse back button does. */
export function navigateBack(): void {
  window.dispatchEvent(new CustomEvent(GO_BACK));
}

export function onNavigateBack(cb: () => void): () => void {
  window.addEventListener(GO_BACK, cb);
  return () => window.removeEventListener(GO_BACK, cb);
}
