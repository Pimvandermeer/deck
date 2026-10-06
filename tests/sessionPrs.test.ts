import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const sessions = vi.hoisted(() => new Map<string, { transcript_path: string }>());
vi.mock("../src/main/github.js", () => ({ prSummary: async () => null }));
vi.mock("../src/main/indexer.js", () => ({ transcriptPath: () => undefined }));
vi.mock("../src/main/sessions.js", () => ({ getSession: (id: string) => sessions.get(id) }));
const { createdPrs, sessionCreatedPrs, sessionPrActivity } = await import("../src/main/sessionPrs.js");

const line = (row: unknown) => JSON.stringify(row);
const claudeCall = (id: string, command: string) =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const claudeResult = (id: string, content: unknown) =>
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });
const codexCall = (call_id: string, cmd: string) =>
  line({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }), call_id } });
const codexOutput = (call_id: string, output: string) =>
  line({ type: "response_item", payload: { type: "function_call_output", call_id, output } });

describe("createdPrs", () => {
  it("pairs a Claude gh pr create with the output that printed the new PR", () => {
    const prs = createdPrs([
      claudeCall("t1", "git push -u origin INI-1 && gh pr create --title 'INI-1: fix'"),
      claudeResult("t1", "remote: https://github.com/acme/api/pull/new/INI-1\nok created #12 https://github.com/acme/api/pull/12"),
    ]);
    expect(prs).toEqual([{ repo: "acme/api", number: 12, url: "https://github.com/acme/api/pull/12" }]);
  });

  it("ignores pull request links the agent merely looked at", () => {
    const prs = createdPrs([
      claudeCall("t1", "gh pr view 7 -R acme/api"),
      claudeResult("t1", "https://github.com/acme/api/pull/7"),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "See https://github.com/acme/api/pull/8" }] } }),
    ]);
    expect(prs).toEqual([]);
  });

  it("reads tool results stored as content blocks", () => {
    const prs = createdPrs([
      claudeCall("t1", "gh pr create -f"),
      claudeResult("t1", [{ type: "text", text: "https://github.com/acme/api/pull/3" }]),
    ]);
    expect(prs.map((pr) => pr.url)).toEqual(["https://github.com/acme/api/pull/3"]);
  });

  it("pairs a Codex function call with its output", () => {
    const prs = createdPrs([
      codexCall("c1", "gh pr create --fill"),
      codexOutput("c1", "Process exited with code 0\nOutput:\nhttps://github.com/acme/web/pull/41\n"),
      codexCall("c2", "gh pr list"),
      codexOutput("c2", "#42 https://github.com/acme/web/pull/42"),
    ]);
    expect(prs).toEqual([{ repo: "acme/web", number: 41, url: "https://github.com/acme/web/pull/41" }]);
  });

  it("lists each pull request once and skips lines that are not records", () => {
    const prs = createdPrs([
      "not json",
      claudeCall("t1", "gh pr create"),
      claudeResult("t1", "https://github.com/acme/api/pull/5"),
      claudeCall("t2", "gh pr create"),
      claudeResult("t2", "already exists: https://github.com/acme/api/pull/5"),
    ]);
    expect(prs.map((pr) => pr.number)).toEqual([5]);
  });
});

describe("sessionCreatedPrs", () => {
  it("reads a growing transcript on from where it stopped, pairing a call and a result that arrive apart", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deck-transcript-")), "session.jsonl");
    sessions.set("s1", { transcript_path: file });
    fs.writeFileSync(file, `${claudeCall("t1", "gh pr create --fill")}\n`);
    expect(await sessionCreatedPrs("s1")).toEqual([]);
    // Half a line: the agent is still writing it.
    const result = claudeResult("t1", "https://github.com/acme/api/pull/31");
    fs.appendFileSync(file, result.slice(0, 20));
    expect(await sessionCreatedPrs("s1")).toEqual([]);
    fs.appendFileSync(file, `${result.slice(20)}\n`);
    expect(await sessionCreatedPrs("s1")).toEqual(["acme/api#31"]);
    expect(await sessionCreatedPrs("s1")).toEqual(["acme/api#31"]);
  });
});

describe("PRs a session worked on", () => {
  it("takes PR links from prompts and PR numbers from gh commands, not from tool output", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deck-touched-")), "session.jsonl");
    sessions.set("s2", { transcript_path: file });
    fs.writeFileSync(file, [
      line({ type: "user", message: { role: "user", content: "review this pr https://github.com/acme/api/pull/40" } }),
      claudeCall("t1", "gh pr diff 41"),
      claudeCall("t2", "gh pr view 42 -R acme/web --comments"),
      claudeCall("t3", "gh api repos/acme/api/pulls/43/comments"),
      claudeCall("t4", "gh pr list"),
      claudeResult("t4", "https://github.com/acme/api/pull/99 https://github.com/acme/api/pull/98"),
      codexCall("c1", "gh pr checks 44 --repo acme/api"),
    ].join("\n") + "\n");
    const { touched } = await sessionPrActivity("s2");
    expect(touched).toEqual(["acme/api#44", "acme/api#43", "acme/web#42", "?#41", "acme/api#40"]);
  });
});
