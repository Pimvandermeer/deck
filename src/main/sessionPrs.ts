import fs from "node:fs";
import readline from "node:readline";
import { sessionAgent } from "../shared/agents.js";
import { prSummary, type IssuePr } from "./github.js";
import { transcriptPath } from "./indexer.js";
import { getSession } from "./sessions.js";
import { contentText } from "./transcripts.js";

// The pull requests an agent session opened, read back from its transcript:
// every `gh pr create` the agent ran, paired with the output that call
// printed, which is where the new PR's URL appears. The transcript is the
// only record that survives the session; hooks never see tool output.

const CREATE = /\bgh\s+pr\s+create\b/;
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/g;

export interface CreatedPr {
  repo: string;
  number: number;
  url: string;
}

/** What a scan has seen so far, so a growing transcript can be read on from where it left off. */
interface ScanState {
  creating: Set<string>;
  found: Map<string, CreatedPr>;
  /** PRs the session worked on, as "owner/name#n" ("?#n" when the command
   *  left the repository to the checkout), mapped to when they last came up. */
  touched: Map<string, number>;
  seq: number;
}

const newScan = (): ScanState => ({ creating: new Set(), found: new Map(), touched: new Map(), seq: 0 });

const GH_PR = /\bgh\s+pr\s+(?:view|diff|checks|review|comment|checkout|merge|ready|edit)\s+(\d+)\b([^\n;&|]*)/g;
const REPO_FLAG = /(?:-R|--repo)[=\s]+([\w.-]+\/[\w.-]+)/;
const API_PULL = /repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)\b/g;

/** Every PR a prompt or a command points at: links, `gh pr <verb> <n>` and
 *  `gh api repos/…/pulls/<n>`. Tool output is never read here: a `gh pr list`
 *  names dozens of PRs the session did not work on. */
function notePrs(text: string, state: ScanState): void {
  const touch = (key: string) => state.touched.set(key, ++state.seq);
  for (const [, repo, number] of text.matchAll(PR_URL)) touch(`${repo}#${number}`);
  for (const [, number, rest] of text.matchAll(GH_PR)) touch(`${REPO_FLAG.exec(rest)?.[1] ?? "?"}#${number}`);
  for (const [, repo, number] of text.matchAll(API_PULL)) touch(`${repo}#${number}`);
}

/** The pull requests a transcript shows being created, in order, each once.
 *  Claude keeps calls in assistant `tool_use` blocks and their results in
 *  user `tool_result` blocks; Codex keeps `function_call` and
 *  `function_call_output` items. Both pair up on an id, so a URL only
 *  counts when it came out of a `gh pr create`. */
export function createdPrs(lines: Iterable<string>, state: ScanState = newScan()): CreatedPr[] {
  const { creating, found } = state;
  const collect = (text: string) => {
    for (const [url, repo, number] of text.matchAll(PR_URL)) found.set(url, { repo, number: Number(number), url });
  };
  for (const line of lines) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    const message = row.message as { role?: string; content?: unknown } | undefined;
    if (row.type === "user" && message?.role === "user") notePrs(contentText(message.content), state);
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === "tool_use") {
        const input = JSON.stringify(block.input ?? "");
        notePrs(input, state);
        if (CREATE.test(input)) creating.add(block.id);
      }
      if (block?.type === "tool_result" && creating.has(block.tool_use_id)) collect(contentText(block.content));
    }
    const payload = row.payload as { type?: string; role?: string; content?: unknown; message?: unknown; call_id?: string; arguments?: unknown; input?: unknown; output?: unknown } | undefined;
    if (payload?.type === "message" && payload.role === "user") notePrs(contentText(payload.content), state);
    if (payload?.type === "user_message" && typeof payload.message === "string") notePrs(payload.message, state);
    if (payload?.call_id) {
      const call = String(payload.arguments ?? payload.input ?? "");
      if (payload.output === undefined) notePrs(call, state);
      if (CREATE.test(call)) creating.add(payload.call_id);
      if (creating.has(payload.call_id) && payload.output !== undefined) collect(contentText(payload.output));
    }
  }
  return [...found.values()];
}

async function readLines(file: string): Promise<string[]> {
  const lines: string[] = [];
  const reader = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of reader) if (line.length < 2_000_000) lines.push(line);
  return lines;
}

const TTL_MS = 30_000;
const cache = new Map<string, { expires: number; result: Promise<IssuePr[]> }>();

/** The session's pull requests with their current state on GitHub, newest
 *  first. Empty when the session opened none, or its transcript is gone. */
export function sessionPullRequests(sessionId: string): Promise<IssuePr[]> {
  const cached = cache.get(sessionId);
  if (cached && cached.expires > Date.now()) return cached.result;
  const result = (async () => {
    const session = getSession(sessionId);
    if (!session) return [];
    const agent = sessionAgent(sessionId);
    const file = session.transcript_path ?? transcriptPath(agent, sessionId.replace(/^codex:/, ""));
    if (!file || !fs.existsSync(file)) return [];
    const prs = await Promise.all(createdPrs(await readLines(file)).map((pr) => prSummary(pr.repo, pr.number)));
    return prs.filter((pr): pr is IssuePr => pr !== null).sort((a, b) => b.number - a.number);
  })().catch(() => []);
  cache.set(sessionId, { expires: Date.now() + TTL_MS, result });
  return result;
}

const scans = new Map<string, { file: string; offset: number; state: ScanState; midLine: boolean }>();
const FIRST_READ_MAX = 16 * 1024 * 1024;

export interface SessionPrActivity {
  /** prKeys of the PRs the session opened. */
  created: string[];
  /** prKeys of the PRs it worked on, most recent first; "?#n" when the repository was the checkout's. */
  touched: string[];
}

/** The PRs a session opened and worked on, from its transcript alone (no
 *  GitHub call). A running agent's transcript only grows, so each call reads
 *  just the complete lines added since the last one. */
export async function sessionPrActivity(sessionId: string): Promise<SessionPrActivity> {
  const none = { created: [], touched: [] };
  const session = getSession(sessionId);
  if (!session) return none;
  const file = session.transcript_path ?? transcriptPath(sessionAgent(sessionId), sessionId.replace(/^codex:/, ""));
  if (!file) return none;
  const size = (await fs.promises.stat(file).catch(() => undefined))?.size;
  if (size === undefined) return none;
  let scan = scans.get(sessionId);
  // A long session's first read takes its tail only; what it worked on lately is what matters.
  if (!scan || scan.file !== file || size < scan.offset) {
    const offset = Math.max(0, size - FIRST_READ_MAX);
    scan = { file, offset, state: newScan(), midLine: offset > 0 };
  }
  scans.set(sessionId, scan);
  if (size > scan.offset) {
    const handle = await fs.promises.open(file, "r");
    try {
      const chunk = Buffer.alloc(size - scan.offset);
      await handle.read(chunk, 0, chunk.length, scan.offset);
      const end = chunk.lastIndexOf(0x0a);
      // Started mid-file: the first line is a fragment.
      const start = scan.midLine ? chunk.indexOf(0x0a) + 1 : 0;
      if (end >= 0) {
        createdPrs(chunk.subarray(start, end).toString("utf8").split("\n").filter((line) => line.length < 2_000_000), scan.state);
        scan.offset += end + 1;
        scan.midLine = false;
      }
    } finally {
      await handle.close();
    }
  }
  return {
    created: [...scan.state.found.values()].map((pr) => `${pr.repo}#${pr.number}`),
    touched: [...scan.state.touched].sort((a, b) => b[1] - a[1]).map(([key]) => key),
  };
}

/** The prKeys of the PRs the session opened. */
export async function sessionCreatedPrs(sessionId: string): Promise<string[]> {
  return (await sessionPrActivity(sessionId)).created;
}

/** Forgets the cached states so a rescan asks GitHub again. */
export function invalidateSessionPullRequests(): void {
  cache.clear();
}
