import { describe, expect, it } from "vitest";
import { CodeHubClient, CodeHubCommandError } from "../../src/codehub.js";
import type { CommandOptions, CommandResult, CommandRunner } from "../../src/process.js";

class HandlerRunner implements CommandRunner {
  readonly calls: string[][] = [];
  constructor(private readonly handler: (args: readonly string[]) => CommandResult) {}
  async run(_command: string, args: readonly string[], _options?: CommandOptions) {
    this.calls.push([...args]);
    return this.handler(args);
  }
}

const repository = {
  repo_id: "1",
  full_name: "g/r",
  clone_urls: { ssh: "git@example.test:g/r.git", https: "https://example.test/g/r.git" },
};
const mr = {
  repo_id: "1",
  mr_id: "9",
  iid: "2",
  title: "MR",
  state: "opened",
  is_draft: false,
  author: {},
  source_branch: "feature",
  target_branch: "main",
  updated_at: "now",
  web_url: null,
};
const commit = {
  sha: "abc",
  title: "commit",
  message: "commit",
  author: {},
  committer: {},
  authored_at: null,
  committed_at: null,
  parent_shas: [],
};

function result(value: unknown): CommandResult {
  return { exitCode: 0, signal: null, stdout: JSON.stringify(value), stderr: "" };
}

describe("CodeHub fixed CLI contract", () => {
  it("uses only the documented argument-array commands", async () => {
    const commentBody = '### Review title\n\nQuoted: "value"\nPath: `src\\file.ts`';
    const runner = new HandlerRunner((args) => {
      if (args[0] === "repo") return result(repository);
      if (args[1] === "list") return result([mr]);
      if (args[1] === "view") return result(mr);
      if (args[1] === "commits") return result([commit]);
      return result({
        comment_id: "c1",
        repo_id: "1",
        mr_iid: "2",
        severity: "major",
        resolved: false,
        web_url: null,
      });
    });
    const client = new CodeHubClient(runner, "codehub", 100);
    await expect(client.repoView("1")).resolves.toMatchObject({ repo_id: "1" });
    await expect(client.mrList("1")).resolves.toHaveLength(1);
    await expect(client.mrView("1", "2")).resolves.toMatchObject({ iid: "2" });
    await expect(client.mrCommits("1", "2")).resolves.toHaveLength(1);
    await expect(client.createComment("1", "2", commentBody, "major")).resolves.toMatchObject({
      comment_id: "c1",
    });
    expect(runner.calls).toEqual([
      ["repo", "view", "1", "--output", "json"],
      ["mr", "list", "--project-id", "1", "--state", "open", "--output", "json"],
      ["mr", "view", "2", "--project-id", "1", "--output", "json"],
      ["mr", "commits", "2", "--project-id", "1", "--output", "json"],
      [
        "mr",
        "comment",
        "create",
        "2",
        "--project-id",
        "1",
        "--body",
        JSON.stringify(commentBody),
        "--severity",
        "major",
        "--output",
        "json",
      ],
    ]);
  });

  it.each(["fatal", "major", "minor", "suggestion"] as const)(
    "passes the CodeHub severity %s unchanged",
    async (severity) => {
      const runner = new HandlerRunner((args) => result({
        comment_id: "c1",
        repo_id: "1",
        mr_iid: "2",
        severity: args[args.indexOf("--severity") + 1],
        resolved: false,
        web_url: null,
      }));
      const client = new CodeHubClient(runner);

      await expect(client.createComment("1", "2", "body", severity)).resolves.toMatchObject({
        severity,
      });
      expect(runner.calls[0]!.slice(-4)).toEqual(["--severity", severity, "--output", "json"]);
    },
  );

  it("classifies stable errors using stderr code and status", async () => {
    const runner = new HandlerRunner(() => ({
      exitCode: 8,
      signal: null,
      stdout: "",
      stderr: JSON.stringify({ code: "WRITE_RESULT_UNKNOWN", message: "token=secret", http_status: 504 }),
    }));
    const client = new CodeHubClient(runner);
    const error = await client.repoView("1").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CodeHubCommandError);
    expect(error).toMatchObject({
      externalCode: "WRITE_RESULT_UNKNOWN",
      httpStatus: 504,
      message: "token=***",
    });
  });

  it("accepts documented nullable metadata from successful commands", async () => {
    const runner = new HandlerRunner((args) => {
      if (args[0] === "repo") {
        return result({
          repo_id: "1",
          full_name: null,
          clone_urls: { ssh: null, https: "https://example.test/g/r.git" },
          archived: null,
          updated_at: null,
          default_branch: null,
          web_url: null,
        });
      }
      if (args[1] === "list" || args[1] === "view") {
        return result(
          args[1] === "list"
            ? [{ ...mr, mr_id: null, title: null, is_draft: null }]
            : { ...mr, mr_id: null, title: null, is_draft: null },
        );
      }
      if (args[1] === "commits") {
        return result([
          {
            sha: null,
            title: null,
            message: null,
            author: null,
            committer: null,
            authored_at: null,
            committed_at: null,
            parent_shas: null,
          },
        ]);
      }
      return result({
        comment_id: "c1",
        repo_id: "1",
        mr_iid: "2",
        severity: "major",
        resolved: null,
        web_url: null,
      });
    });
    const client = new CodeHubClient(runner);
    await expect(client.repoView("1")).resolves.toMatchObject({ full_name: null });
    await expect(client.mrList("1")).resolves.toEqual([
      expect.objectContaining({ mr_id: null, title: null, is_draft: null }),
    ]);
    await expect(client.mrView("1", "2")).resolves.toMatchObject({ mr_id: null });
    await expect(client.mrCommits("1", "2")).resolves.toEqual([
      expect.objectContaining({ sha: null, parent_shas: null }),
    ]);
    await expect(client.createComment("1", "2", "body", "major")).resolves.toMatchObject({
      comment_id: "c1",
      resolved: null,
    });
  });

  it("classifies a successful comment response without an ID as unknown", async () => {
    const client = new CodeHubClient(
      new HandlerRunner(() =>
        result({
          comment_id: null,
          repo_id: "1",
          mr_iid: "2",
          severity: "major",
          resolved: null,
          web_url: null,
        }),
      ),
    );
    await expect(client.createComment("1", "2", "body", "major")).rejects.toMatchObject({
      externalCode: "WRITE_RESULT_UNKNOWN",
    });
  });

  it.each([
    [{ exitCode: 1, signal: null, stdout: "", stderr: "plain failure" }, "UNCLASSIFIED_ERROR"],
    [{ exitCode: 0, signal: null, stdout: "{}", stderr: "warning" }, "INVALID_OUTPUT"],
    [{ exitCode: 0, signal: null, stdout: "not-json", stderr: "" }, "INVALID_OUTPUT"],
    [{ exitCode: 0, signal: null, stdout: "{}", stderr: "" }, "INVALID_OUTPUT"],
  ] as const)("rejects invalid process result %#", async (commandResult, externalCode) => {
    const client = new CodeHubClient(new HandlerRunner(() => commandResult));
    await expect(client.repoView("1")).rejects.toMatchObject({ externalCode });
  });
});
