import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenCodeClient, type AgentRunOptions } from "../../src/opencode.js";
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

let artifactRoot: string;

function runOptions(name: string, signal?: AbortSignal): AgentRunOptions {
  return {
    artifactDir: path.join(artifactRoot, name),
    timeoutMs: 1234,
    ...(signal === undefined ? {} : { signal }),
  };
}

beforeEach(async () => {
  artifactRoot = await mkdtemp(path.join(os.tmpdir(), "reviewx-agent-output-"));
});

afterEach(async () => {
  delete process.env.CODEHUB_TEST_TOKEN;
  delete process.env.DEVUC_ACCESS_TOKEN;
  delete process.env.PRIVATE_TOKEN;
  delete process.env.REVIEWX_OPENCODE_MODEL;
  await rm(artifactRoot, { recursive: true, force: true });
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
      client.runExpert(
        "design-reviewer",
        "C:/worktree",
        "C:/input.json",
        runOptions("design", controller.signal),
      ),
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
      client.runExpert("design-reviewer", "worktree", "input", runOptions("wrong-expert")),
    ).rejects.toThrowError(/returned result for business-reviewer/u);
  });

  it("wraps invalid expert and judge schemas", async () => {
    const runner = new AgentRunner(() => success({ unexpected: true, token: "secret-value" }));
    const client = new OpenCodeClient(runner, "fake", "./opencode");
    await expect(
      client.runExpert("code-reviewer", "worktree", "input", runOptions("invalid-expert")),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/invalid result/u),
      details: {
        agent: "code-reviewer",
        agent_output: '{"unexpected":true,"token":"***"}',
        agent_output_source: "assistant_text",
        agent_output_truncated: false,
      },
    });
    await expect(
      client.runJudge("worktree", "input", runOptions("invalid-judge")),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Judge returned an invalid result/u),
      details: {
        agent: "review-judge",
        agent_output: '{"unexpected":true,"token":"***"}',
        agent_output_source: "assistant_text",
        agent_output_truncated: false,
      },
    });
  });

  it("accepts a valid judge result", async () => {
    const runner = new AgentRunner(() => success({ verdict: "pass" }));
    const client = new OpenCodeClient(runner, "fake", "./opencode");
    await expect(
      client.runJudge("worktree", "input", runOptions("valid-judge")),
    ).resolves.toEqual({ verdict: "pass" });
    expect(JSON.parse(await readFile(path.join(artifactRoot, "valid-judge", "metadata.json"), "utf8")))
      .toMatchObject({
        agent: "review-judge",
        status: "succeeded",
        strategy: "whole",
        parse_status: "succeeded",
        schema_status: "succeeded",
      });
    expect(JSON.parse(await readFile(path.join(artifactRoot, "valid-judge", "result.json"), "utf8")))
      .toEqual({ verdict: "pass" });
  });

  it("accepts an expert result after narrated analysis", async () => {
    const result = {
      expert: "design-reviewer",
      verdict: "pass",
      findings: [],
    };
    const runner = new AgentRunner(() => ({
      exitCode: 0,
      signal: null,
      stdout: `${JSON.stringify({
        type: "text",
        part: { text: `The base is develop.\n\nLet me compose the JSON.\n\n${JSON.stringify(result)}` },
      })}\n`,
      stderr: "",
    }));
    const client = new OpenCodeClient(runner, "fake", "./opencode");

    await expect(
      client.runExpert("design-reviewer", "worktree", "input", runOptions("narrated")),
    ).resolves.toEqual(result);
  });

  it("attributes malformed output to the responsible agent", async () => {
    const runner = new AgentRunner(() => ({
      exitCode: 0,
      signal: null,
      stdout: `${JSON.stringify({ type: "text", part: { text: "not-json" } })}\n`,
      stderr: "",
    }));
    const client = new OpenCodeClient(runner, "fake", "./opencode");
    await expect(
      client.runExpert("business-reviewer", "worktree", "input", runOptions("malformed")),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/OpenCode agent business-reviewer returned invalid output/u),
      details: {
        agent: "business-reviewer",
        agent_output: "not-json",
        agent_output_source: "assistant_text",
        agent_output_chars: 8,
        agent_output_truncated: false,
      },
    });
  });

  it("falls back to raw OpenCode stdout when its event stream is malformed", async () => {
    const client = new OpenCodeClient(
      new AgentRunner(() => ({
        exitCode: 0,
        signal: null,
        stdout: "not-jsonl\n",
        stderr: "",
      })),
      "fake",
      "./opencode",
    );
    await expect(
      client.runJudge("worktree", "input", runOptions("bad-jsonl")),
    ).rejects.toMatchObject({
      details: {
        agent: "review-judge",
        agent_output: "not-jsonl\n",
        agent_output_source: "opencode_stdout",
        agent_output_chars: 10,
        agent_output_truncated: false,
      },
    });
  });

  it.each([
    [{ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "token=secret\n" }, "unknown"],
    [{ exitCode: 4, signal: null, stdout: "", stderr: "" }, "4"],
  ] as const)("rejects non-zero OpenCode exits", async (result, exitText) => {
    const client = new OpenCodeClient(new AgentRunner(() => result), "fake", "./opencode");
    await expect(
      client.runJudge("worktree", "input", runOptions(`exit-${exitText}`)),
    ).rejects.toMatchObject({
      message: expect.stringMatching(new RegExp(`exit code ${exitText}`, "u")),
      details: {
        agent: "review-judge",
        agent_output_artifact: path.join(artifactRoot, `exit-${exitText}`),
      },
    });
  });

  it("constructs with the packaged default configuration", () => {
    expect(new OpenCodeClient()).toBeInstanceOf(OpenCodeClient);
  });
});
