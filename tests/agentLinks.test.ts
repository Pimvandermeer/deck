import { describe, expect, it } from "vitest";
import { agentsForPr, agentsForTicket, continueTarget, reasonLabel, repoFromRemote, type AgentLink } from "../src/shared/agentLinks.js";

const link = (sessionId: string, extra: Partial<AgentLink> = {}): AgentLink => ({
  sessionId, termId: `t-${sessionId}`, agent: "claude", status: "idle", title: null, cwd: "/src/api",
  issueKey: null, branch: null, repo: "acme/api", createdPrs: [], touchedPrs: [], reviewNote: null, updatedAt: 0, ...extra,
});
const pr = { repo: "acme/api", number: 7, headRefName: "feat/login" };

describe("agents on a PR", () => {
  it("links by branch, by the PR the agent opened, and by ticket, strongest first", () => {
    const links = [
      link("ticket", { issueKey: "APP-1", updatedAt: 3 }),
      link("opened", { createdPrs: ["acme/api#7"], updatedAt: 2 }),
      link("branch", { branch: "feat/login", updatedAt: 1 }),
      link("other", { branch: "feat/else", issueKey: "APP-2" }),
    ];
    const found = agentsForPr(pr, "APP-1", links);
    expect(found.map((a) => [a.link.sessionId, a.reason])).toEqual([["branch", "branch"], ["opened", "opened"], ["ticket", "ticket"]]);
    expect(reasonLabel(found[0])).toBe("on feat/login");
  });

  it("does not take a same-named branch in another repository", () => {
    expect(agentsForPr(pr, undefined, [link("fork", { branch: "feat/login", repo: "acme/web" })])).toEqual([]);
    // No origin known: the branch alone decides.
    expect(agentsForPr(pr, undefined, [link("local", { branch: "feat/login", repo: null })])).toHaveLength(1);
  });

  it("lists the agents waiting on the user first, and each session once", () => {
    const links = [link("busy", { branch: "feat/login", status: "working", updatedAt: 9 }), link("asking", { issueKey: "APP-1", status: "needs_input" })];
    expect(agentsForPr(pr, "APP-1", links).map((a) => a.link.sessionId)).toEqual(["asking", "busy"]);
    const both = link("both", { branch: "feat/login", issueKey: "APP-1" });
    const ticket = agentsForTicket("APP-1", [pr], [both]);
    expect(ticket).toHaveLength(1);
    expect(ticket[0].reason).toBe("branch");
  });
});

describe("repository from an origin url", () => {
  it("reads ssh and https spellings", () => {
    expect(repoFromRemote("git@github.com:acme/web.git")).toBe("acme/web");
    expect(repoFromRemote("https://github.com/acme/docs")).toBe("acme/docs");
    expect(repoFromRemote("https://github.com/fishuke/deck.git\n")).toBe("fishuke/deck");
    expect(repoFromRemote("ssh://git@github.com/acme/api.git")).toBe("acme/api");
    expect(repoFromRemote("https://gitlab.com/acme/api.git")).toBeNull();
  });
});

describe("which agent to continue with", () => {
  const author = link("author", { branch: "feat/login", updatedAt: 5 });
  const reviewer = link("reviewer", { touchedPrs: ["acme/api#7"], cwd: "/src/api-main", updatedAt: 1 });

  it("links a session that worked on the PR from another branch", () => {
    expect(agentsForPr(pr, undefined, [reviewer]).map((a) => [a.link.sessionId, reasonLabel(a)])).toEqual([["reviewer", "worked on this PR"]]);
  });

  it("goes back to the reviewing session for a review, and to the branch for work on the PR", () => {
    const agents = agentsForPr(pr, undefined, [author, reviewer]);
    expect(continueTarget(agents, true)?.link.sessionId).toBe("reviewer");
    expect(continueTarget(agents, false)?.link.sessionId).toBe("author");
    // One waiting on the user comes first either way.
    const asking = agentsForPr(pr, undefined, [author, { ...reviewer, status: "needs_input" }]);
    expect(continueTarget(asking, false)?.link.sessionId).toBe("reviewer");
  });
});
