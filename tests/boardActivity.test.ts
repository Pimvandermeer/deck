import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardIssue } from "../src/main/board/types.js";

// PR activity for every board card: merged and own PRs stay in, closed
// ones drop out, and the first fetch marks everything as already seen.

const state = vi.hoisted(() => ({ queries: [] as string[], kv: new Map<string, unknown>() }));
vi.mock("../src/main/db.js", () => ({ kvGet: (key: string) => state.kv.get(key), kvSet: (key: string, value: unknown) => state.kv.set(key, value) }));
vi.mock("../src/main/settings.js", async () => {
  const { defaultSettings } = await import("../src/shared/settings.js");
  return { getSettings: () => ({ ...defaultSettings, activeWorkspace: "w" }) };
});

const issue = (key: string, statusName: string): BoardIssue =>
  ({ id: key, key, summary: "", statusId: "1", statusName, assignee: null, assigneeId: null, updated: "", url: "" });

vi.mock("../src/main/board/board.js", () => ({
  boardConfigured: () => true,
  getBoardCache: () => ({ provider: "jira", boardName: "B", at: 0, columns: [], issues: [issue("A-1", "Review"), issue("A-2", "Review")] }),
}));
vi.mock("../src/main/prInbox.js", () => ({
  getPrInbox: () => ({ viewer: "me", mine: [], reviewRequested: [{ repo: "acme/web", number: 7 }], reviewed: [], reviewColumn: [], at: 0 }),
}));

const linked: Record<string, { repo: string; number: number; state: string }[]> = {
  "A-1": [{ repo: "acme/api", number: 11, state: "OPEN" }, { repo: "acme/api", number: 12, state: "CLOSED" }],
  "A-2": [{ repo: "acme/api", number: 13, state: "MERGED" }, { repo: "not a repo", number: 14, state: "OPEN" }],
};
vi.mock("../src/main/issuePrs.js", () => ({ cachedPrsForIssue: () => undefined, prsForIssue: (key: string) => Promise.resolve(linked[key] ?? []) }));

const node = (number: number, extra: Record<string, unknown> = {}) => ({
  number, title: `PR ${number}`, url: "", createdAt: "2026-09-01T10:00:00Z", isDraft: false, state: "OPEN", mergedAt: null,
  updatedAt: "2026-09-02T10:00:00Z", headRefName: `f${number}`, headRefOid: `h${number}`, baseRefName: "main", reviewDecision: null, mergeable: "MERGEABLE",
  author: { __typename: "User", login: "me" }, repository: { nameWithOwner: number === 7 ? "acme/web" : "acme/api" },
  commits: { nodes: [{ commit: { oid: `h${number}`, committedDate: "2026-09-02T10:00:00Z", author: { name: "Me", user: { login: "me" } }, statusCheckRollup: { state: "SUCCESS" } } }] },
  reviews: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] },
  ...extra,
});

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return {
    execFile: Object.assign(() => {}, {
      [promisify.custom]: async (_bin: string, args: string[]) => {
        const query = args[args.indexOf("-f") + 1];
        state.queries.push(query);
        const data = {
          viewer: { login: "me" },
          pr0: { pullRequest: node(11, {
            reviews: { nodes: [
              { state: "COMMENTED", submittedAt: "2026-09-03T09:00:00Z", author: { __typename: "User", login: "rev" }, commit: { oid: "h11" } },
              { state: "COMMENTED", submittedAt: "2026-09-03T10:00:00Z", author: { __typename: "Bot", login: "copilot-pull-request-reviewer" }, commit: { oid: "h11" } },
              { state: "COMMENTED", submittedAt: "2026-09-03T11:00:00Z", author: { __typename: "User", login: "me" }, commit: { oid: "h11" } },
            ] },
            comments: { nodes: [{ createdAt: "2026-09-03T12:00:00Z", author: { __typename: "Bot", login: "github-actions" } }] },
            reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] },
          }) },
          pr1: { pullRequest: node(13, { state: "MERGED", mergedAt: "2026-09-04T10:00:00Z" }) },
          // A repository the user cannot see.
          pr2: null,
        };
        // gh exits non-zero when any alias failed, with the rest on stdout.
        throw Object.assign(new Error("gh: Could not resolve to a Repository"), { stdout: JSON.stringify({ data, errors: [{ message: "not found" }] }) });
      },
    }),
  };
});

import { getActivitySeen, markActivitySeen, refreshBoardActivity } from "../src/main/boardActivity.js";

describe("board activity", () => {
  beforeEach(() => {
    state.queries = [];
    state.kv.clear();
  });

  it("follows board and inbox PRs in one batch, keeping merged and own PRs", async () => {
    const activity = await refreshBoardActivity();
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]).toContain(`repository(owner: "acme", name: "api") { pullRequest(number: 11)`);
    expect(state.queries[0]).toContain(`pullRequest(number: 7)`);
    expect(state.queries[0]).not.toContain("number: 12");
    expect(state.queries[0]).not.toContain("number: 14");
    expect(activity.tickets).toEqual({ "A-1": ["acme/api#11"], "A-2": ["acme/api#13"] });
    expect(Object.keys(activity.prs).sort()).toEqual(["acme/api#11", "acme/api#13"]);
    expect(activity.prs["acme/api#13"].state).toBe("MERGED");
  });

  it("reads the last review past bots and the author, and counts open threads", async () => {
    const pr = (await refreshBoardActivity()).prs["acme/api#11"];
    expect(pr.lastReview).toEqual({ at: "2026-09-03T09:00:00Z", author: "rev", state: "COMMENTED", onHead: true });
    // The user's own reply and the bot's comment are not news to them.
    expect(pr.lastTalk).toEqual({ at: "2026-09-03T09:00:00Z", author: "rev", kind: "review", state: "COMMENTED" });
    expect(pr.unresolvedThreads).toBe(2);
    expect(pr.lastCommit).toEqual({ at: "2026-09-02T10:00:00Z", author: "me", oid: "h11" });
  });

  it("marks everything seen on the first fetch, and a ticket's PRs with it later", async () => {
    await refreshBoardActivity();
    const seen = getActivitySeen()!;
    expect(Object.keys(seen.tickets).sort()).toEqual(["A-1", "A-2"]);
    expect(seen.prs["acme/api#11"].head).toBe("h11");
    state.kv.set("activity_seen@w", { tickets: {}, prs: {} });
    const marked = markActivitySeen({ tickets: ["A-1"] });
    expect(marked.tickets["A-1"].status).toBe("Review");
    expect(Object.keys(marked.prs)).toEqual(["acme/api#11"]);
  });
});
