import { describe, expect, it } from "vitest";
import { activityRows, ballFor, ballFrom, ballText, markPr, mismatchFlags, prChanges, stackedOn, summarizeBalls, ticketBall, type ActivityPr, type ActivitySeen, type BoardActivity } from "../src/shared/activity.js";

const pr = (number: number, extra: Partial<ActivityPr> = {}): ActivityPr => ({
  repo: "acme/api", number, title: `PR ${number}`, url: "", author: "dev", createdAt: "2026-09-01T10:00:00Z",
  state: "OPEN", isDraft: false, mergedAt: null, updatedAt: "2026-09-02T10:00:00Z",
  headRefName: `feat/${number}`, baseRefName: "main", headOid: `h${number}`, reviewDecision: null, mergeable: "MERGEABLE", checks: "SUCCESS",
  lastCommit: { at: "2026-09-02T10:00:00Z", author: "dev", oid: `h${number}` }, lastReview: null, lastTalk: null, unresolvedThreads: 0,
  ...extra,
});

const issue = (key: string, statusName: string, statusId = "1") => ({ key, summary: key, statusId, statusName, assigneeId: null, updated: "2026-09-01T12:00:00.000+0200" });
const rules = { reviewColumns: ["Review"] };

describe("ball", () => {
  it("sits with the reviewers until a review sees the head commit", () => {
    expect(ballFor(pr(1))).toBe("review");
    // The review was on an older commit: new work waits on the reviewers again.
    expect(ballFor(pr(1, { lastReview: { at: "2026-09-03T10:00:00Z", author: "rev", state: "CHANGES_REQUESTED", onHead: false } }))).toBe("review");
    expect(ballFor(pr(1, { lastReview: { at: "2026-09-03T10:00:00Z", author: "rev", state: "COMMENTED", onHead: true } }))).toBe("author");
    expect(ballFor(pr(1, { lastReview: { at: "2026-09-03T10:00:00Z", author: "rev", state: "APPROVED", onHead: true } }))).toBe("merge");
  });

  it("is the author's while a draft and nobody's once merged", () => {
    expect(ballFor(pr(1, { isDraft: true }))).toBe("author");
    expect(ballFor(pr(1, { state: "MERGED" }))).toBe("done");
  });
});

describe("changes since the user looked", () => {
  const seen = markPr(pr(1), "2026-09-02T11:00:00Z");

  it("reports nothing when nothing moved", () => {
    expect(prChanges(pr(1), seen, "me")).toEqual([]);
  });

  it("notices a new head by oid, even when the commit date is older", () => {
    const rebased = pr(1, { headOid: "h1b", lastCommit: { at: "2026-08-30T10:00:00Z", author: "dev", oid: "h1b" } });
    expect(prChanges(rebased, seen, "me")).toEqual(["new commits by dev"]);
  });

  it("leaves out the user's own commits and a CI run still pending", () => {
    const own = pr(1, { headOid: "h1b", checks: "PENDING", lastCommit: { at: "2026-09-03T10:00:00Z", author: "me", oid: "h1b" } });
    expect(prChanges(own, seen, "me")).toEqual([]);
  });

  it("names merges, settled CI and reviews", () => {
    const moved = pr(1, { state: "MERGED", checks: "FAILURE", lastTalk: { at: "2026-09-03T10:00:00Z", author: "rev", kind: "review", state: "APPROVED" } });
    expect(prChanges(moved, seen, "me")).toEqual(["merged", "CI failing", "approved by rev"]);
    const commented = pr(1, { lastTalk: { at: "2026-09-03T10:00:00Z", author: "rev", kind: "comment" } });
    expect(prChanges(commented, seen, "me")).toEqual(["comment by rev"]);
  });

  it("calls a PR without a mark new", () => {
    expect(prChanges(pr(2), undefined, "me")).toEqual(["new PR #2"]);
  });
});

describe("mismatch flags", () => {
  it("flags merged work on a ticket that has not moved", () => {
    expect(mismatchFlags(issue("A-1", "Review needed"), "Review", [pr(1, { state: "MERGED" })], rules)).toEqual(["merged, ticket still Review needed"]);
    expect(mismatchFlags(issue("A-1", "Done"), "Done", [pr(1, { state: "MERGED" })], rules)).toEqual([]);
  });

  it("flags review columns without a live PR, or with only drafts", () => {
    expect(mismatchFlags(issue("A-1", "In review"), "Review", [], rules)).toEqual(["in review without a PR"]);
    expect(mismatchFlags(issue("A-1", "In review"), "Review", [pr(1, { state: "CLOSED" })], rules)).toEqual(["in review without a PR"]);
    expect(mismatchFlags(issue("A-1", "In review"), "Review", [pr(1, { isDraft: true })], rules)).toEqual(["in review, PR is a draft"]);
  });

  it("flags a reviewed ticket whose PR still has changes requested, and open PRs on done tickets", () => {
    expect(mismatchFlags(issue("A-1", "REVIEWED"), "Review", [pr(1, { reviewDecision: "CHANGES_REQUESTED" })], rules)).toEqual(["reviewed in the tracker, changes requested on GitHub"]);
    expect(mismatchFlags(issue("A-1", "Done"), "Done", [pr(1)], rules)).toEqual(["ticket done, PR still open"]);
  });
});

describe("rows", () => {
  const activity: BoardActivity = {
    viewer: "me", at: 0,
    prs: { "acme/api#1": pr(1), "acme/api#2": pr(2, { headOid: "new" }), "acme/api#3": pr(3, { lastCommit: { at: "2026-09-09T10:00:00Z", author: "dev", oid: "h3" } }) },
    tickets: { "A-1": ["acme/api#1"], "A-2": ["acme/api#2"], "A-3": ["acme/api#3"], "A-4": [] },
  };
  const at = "2026-09-02T11:00:00Z";
  const seen: ActivitySeen = {
    tickets: { "A-1": { status: "In progress", at }, "A-2": { status: "In progress", at }, "A-3": { status: "In progress", at } },
    prs: { "acme/api#1": markPr(pr(1), at), "acme/api#2": markPr(pr(2), at), "acme/api#3": markPr(activity.prs["acme/api#3"], at) },
  };
  const columns = [{ name: "In progress", statusIds: ["1"] }, { name: "Review", statusIds: ["2"] }];

  it("puts new rows first, then the most recent activity", () => {
    const issues = [issue("A-1", "In progress"), issue("A-2", "In progress"), issue("A-3", "In progress"), issue("A-4", "Review", "2")];
    const rows = activityRows(issues, columns, activity, seen, rules);
    expect(rows.map((row) => row.issue.key)).toEqual(["A-2", "A-4", "A-3", "A-1"]);
    expect(rows[0].changes).toEqual(["new commits by dev"]);
    // Never marked: it came onto the board after the user last looked.
    expect(rows[1].changes).toEqual(["new on the board"]);
    expect(rows[1].flags).toEqual(["in review without a PR"]);
  });

  it("reports a status the tracker moved", () => {
    const rows = activityRows([issue("A-1", "Review", "2")], columns, activity, seen, rules);
    expect(rows[0].changes).toEqual(["In progress → Review"]);
  });

  it("finds the PR a stacked one is based on", () => {
    const base = pr(1, { headRefName: "feat/base" });
    expect(stackedOn(pr(2, { baseRefName: "feat/base" }), [base])?.number).toBe(1);
    expect(stackedOn(pr(2), [base])).toBeUndefined();
  });
});

describe("ball from the viewer's side", () => {
  const onHead = (author: string, state: string, oid = "h1") => ({ at: "2026-09-03T10:00:00Z", author, state, onHead: oid === "h1" });

  it("on the user's own PR: their move after a review on the head, the reviewers' otherwise", () => {
    const mine = pr(1, { author: "me" });
    expect(ballFrom(mine, "me")).toMatchObject({ stance: "them", who: [], action: "review" });
    expect(ballText(ballFrom(mine, "me"))).toBe("Waiting on a review");
    expect(ballFrom(pr(1, { author: "me", requestedReviewers: ["ann", "@firmware"] }), "me")).toMatchObject({ stance: "them", who: ["ann", "@firmware"] });
    const reviewed = pr(1, { author: "me", lastReview: onHead("ann", "CHANGES_REQUESTED"), reviewers: ["ann"] });
    expect(ballText(ballFrom(reviewed, "me"))).toBe("Your move: address review");
    const pushedSince = pr(1, { author: "me", lastReview: { ...onHead("ann", "COMMENTED"), onHead: false }, reviewers: ["ann"] });
    expect(ballText(ballFrom(pushedSince, "me"))).toBe("Waiting on ann to re-review");
    expect(ballText(ballFrom(pr(1, { author: "me", lastReview: onHead("ann", "APPROVED") }), "me"))).toBe("Ready to merge");
    expect(ballText(ballFrom(pr(1, { author: "me", checks: "FAILURE", lastReview: onHead("ann", "APPROVED") }), "me"))).toBe("Your move: fix CI");
  });

  it("on someone else's PR: the user's review when asked, or when they reviewed and commits came since", () => {
    expect(ballText(ballFrom(pr(1), "me", true))).toBe("Your review");
    expect(ballText(ballFrom(pr(1, { requestedReviewers: ["me"] }), "me"))).toBe("Your review");
    const myOldReview = pr(1, { viewerReviewOid: "h0", lastReview: { ...onHead("me", "COMMENTED"), onHead: false }, reviewers: ["me"] });
    expect(ballText(ballFrom(myOldReview, "me"))).toBe("Your re-review");
    // The user reviewed the head: now they wait on the author.
    const waiting = pr(1, { viewerReviewOid: "h1", lastReview: onHead("me", "CHANGES_REQUESTED"), reviewers: ["me"] });
    expect(ballFrom(waiting, "me")).toMatchObject({ stance: "them", who: ["dev"], action: "address" });
    expect(ballText(ballFrom(waiting, "me"))).toBe("Waiting on dev to address review");
  });

  it("between others when the user has no part in it", () => {
    expect(ballText(ballFrom(pr(1), "me"))).toBe("Open for review");
    expect(ballFrom(pr(1, { requestedReviewers: ["ann"] }), "me")).toMatchObject({ stance: "others", who: ["ann"] });
    expect(ballText(ballFrom(pr(1, { lastReview: onHead("ann", "APPROVED") }), "me"))).toBe("dev to merge");
    expect(ballFrom(pr(1, { state: "MERGED" }), "me").stance).toBe("done");
  });

  it("gives a ticket its most pressing ball, an agent waiting on the user first, and counts them", () => {
    const yours = ballFrom(pr(1), "me", true);
    const theirs = ballFrom(pr(2, { author: "me", requestedReviewers: ["ann"] }), "me");
    expect(ticketBall([theirs, yours])).toBe(yours);
    expect(ticketBall([theirs], { since: "2026-09-04T00:00:00Z" })).toMatchObject({ stance: "you", action: "answer agent" });
    const summary = summarizeBalls([yours, theirs, theirs, ballFrom(pr(3), "me"), undefined]);
    expect(summary).toMatchObject({ you: 1, them: 2, others: 1, yourActions: [["review", 1]], waitingOn: [["ann", 2]] });
  });
});
