import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeClient } from "../../src/opencode.js";
import type { CommandOptions, CommandResult, CommandRunner } from "../../src/process.js";

function output(value: unknown): string {
  return `${JSON.stringify({ type: "text", part: { text: JSON.stringify(value) } })}\n`;
}

class AgentRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options: CommandOptions }> = [];

  constructor(private readonly resultFor: (agent: string) => CommandResult) {}

  async run(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    this.calls.push({ command, args: [...args], options });
    return this.resultFor(args[args.indexOf("--agent") + 1]!);
  }
}

function success(value: unknown): CommandResult {
  return { exitCode: 0, signal: null, stdout: output(value), stderr: "" };
}

afterEach(() => {
  delete process.env.CODEHUB_TEST_TOKEN;
  delete process.env.DEVUC_ACCESS_TOKEN;
  delete process.env.PRIVATE_TOKEN;
});

describe("OpenCode client", () => {
  it("passes only the read-only environment and an abort signal", async () => {
    process.env.CODEHUB_TEST_TOKEN = "secret";
    process.env.DEVUC_ACCESS_TOKEN = "secret";
    process.env.PRIVATE_TOKEN = "secret";
    const runner = new AgentRunner((agent) =>
      success({ expert: agent, verdict: "pass", findings: [] }),
    );
    const client = new OpenCodeClient(runner, "fake-opencode", "./opencode");
    const controller = new AbortController();
    await expect(
      client.runExpert("design-reviewer", "C:/worktree", "C:/input.json", 1234, controller.signal),
    ).resolves.toMatchObject({ expert: "design-reviewer", verdict: "pass" });

    const call = runner.calls[0]!;
    expect(call.command).toBe("fake-opencode");
    expect(call.args.slice(0, 4)).toEqual(["run", "--pure", "--agent", "design-reviewer"]);
    expect(call.options).toMatchObject({
      cwd: "C:/worktree",
      timeoutMs: 1234,
      signal: controller.signal,
    });
    expect(call.options.env).not.toHaveProperty("CODEHUB_TEST_TOKEN");
    expect(call.options.env).not.toHaveProperty("DEVUC_ACCESS_TOKEN");
    expect(call.options.env).not.toHaveProperty("PRIVATE_TOKEN");
    expect(JSON.parse(call.options.env!.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      permission: { "*": "deny" },
      agent: { "design-reviewer": { permission: { edit: "deny" } } },
    });
  });

  it("rejects an expert result attributed to a different expert", async () => {
    const runner = new AgentRunner(() =>
      success({ expert: "business-reviewer", verdict: "pass", findings: [] }),
    );
    const client = new OpenCodeClient(runner, "fake", "./opencode");
    await expect(
      client.runExpert("design-reviewer", "worktree", "input", 1),
    ).rejects.toThrowError(/returned result for business-reviewer/u);
  });

  it("wraps invalid expert and judge schemas", async () => {
    const runner = new AgentRunner(() => success({ unexpected: true }));
    const client = new OpenCodeClient(runner, "fake", "./opencode");
    await expect(
      client.runExpert("code-reviewer", "worktree", "input", 1),
    ).rejects.toThrowError(/invalid result/u);
    await expect(client.runJudge("worktree", "input", 1)).rejects.toThrowError(
      /Judge returned an invalid result/u,
    );
  });

  it("accepts a valid judge result", async () => {
    const runner = new AgentRunner(() => success({ verdict: "pass" }));
    const client = new OpenCodeClient(runner, "fake", "./opencode");
    await expect(client.runJudge("worktree", "input", 1)).resolves.toEqual({ verdict: "pass" });
  });

  it.each([
    [{ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "token=secret\n" }, "unknown"],
    [{ exitCode: 4, signal: null, stdout: "", stderr: "" }, "4"],
  ] as const)("rejects non-zero OpenCode exits", async (result, exitText) => {
    const client = new OpenCodeClient(new AgentRunner(() => result), "fake", "./opencode");
    await expect(client.runJudge("worktree", "input", 1)).rejects.toThrowError(
      new RegExp(`exit code ${exitText}`, "u"),
    );
  });

  it("constructs with the packaged default configuration", () => {
    expect(new OpenCodeClient()).toBeInstanceOf(OpenCodeClient);
  });
});
