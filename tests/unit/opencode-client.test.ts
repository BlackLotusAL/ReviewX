import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenCodeClient, type AgentRunOptions } from "../../src/opencode.js";
import type { CommandOptions, CommandResult, CommandRunner } from "../../src/process.js";

function output(text: string): string {
  const split = Math.floor(text.length / 2);
  return `${[text.slice(0, split), text.slice(split)]
    .map((part) => JSON.stringify({ type: "text", part: { text: part } }))
    .join("\n")}\n`;
}

function success(text: string): CommandResult {
  return { exitCode: 0, signal: null, stdout: output(text), stderr: "" };
}

class AgentRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options: CommandOptions }> = [];

  constructor(
    private readonly resultFor: (agent: string, call: number) => CommandResult,
  ) {}

  async run(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    this.calls.push({ command, args: [...args], options });
    const result = this.resultFor(args[args.indexOf("--agent") + 1]!, this.calls.length);
    for (const line of result.stdout.split(/\r?\n/u)) {
      if (line === "") continue;
      await options.onStdoutLine?.(line);
    }
    return result;
  }
}

let artifactRoot: string;
let inputPaths: string[];

function runOptions(name: string, signal?: AbortSignal): AgentRunOptions {
  return {
    artifactDir: path.join(artifactRoot, name),
    timeoutMs: 1234,
    ...(signal === undefined ? {} : { signal }),
  };
}

beforeEach(async () => {
  artifactRoot = await mkdtemp(path.join(os.tmpdir(), "reviewx-agent-output-"));
  inputPaths = await Promise.all(
    ["context.json", "design.md", "business.md", "code.md"].map(async (name, index) => {
      const file = path.join(artifactRoot, name);
      await writeFile(file, index === 0 ? "{}" : `# Report ${index}`, "utf8");
      return file;
    }),
  );
});

afterEach(async () => {
  delete process.env.CODEHUB_TEST_TOKEN;
  delete process.env.DEVUC_ACCESS_TOKEN;
  delete process.env.PRIVATE_TOKEN;
  await rm(artifactRoot, { recursive: true, force: true });
});

describe("OpenCode Markdown client", () => {
  it("passes a read-only environment and persists expert Markdown with replay input", async () => {
    process.env.CODEHUB_TEST_TOKEN = "secret";
    process.env.DEVUC_ACCESS_TOKEN = "secret";
    process.env.PRIVATE_TOKEN = "secret";
    const runner = new AgentRunner(() => success("# PASS\n\nNo issue."));
    const client = new OpenCodeClient(runner, "fake-opencode", "./opencode");
    const controller = new AbortController();

    await expect(
      client.runExpert(
        "design-reviewer",
        artifactRoot,
        inputPaths[0]!,
        runOptions("design", controller.signal),
      ),
    ).resolves.toEqual({ expert: "design-reviewer", markdown: "# PASS\n\nNo issue." });

    const call = runner.calls[0]!;
    expect(call.command).toBe("fake-opencode");
    expect(call.args.slice(0, 4)).toEqual(["run", "--pure", "--agent", "design-reviewer"]);
    expect(call.options).toMatchObject({
      cwd: artifactRoot,
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
    expect(await readFile(path.join(artifactRoot, "design", "report.md"), "utf8"))
      .toBe("# PASS\n\nNo issue.");
    expect(JSON.parse(await readFile(
      path.join(artifactRoot, "design", "input-manifest.json"),
      "utf8",
    )).files).toHaveLength(1);
  });

  it("attaches context plus three reports and persists a valid new Judge document", async () => {
    const markdown = `### 🟡 Minor: 终止消息可能丢失已有报告

**问题描述**：

- 严重级别：Minor
- 标签：\`#correctness\` \`#observability\`
- 简述：终止消息为空时不会回退到之前的有效报告

**问题位置**： \`src/opencode.ts:105-116\`

\`\`\`ts
return terminalMessage.text; // [!code warning] 可能为空
\`\`\`

**影响分析**：

- **直接后果**：有效报告被丢弃
- **影响范围**：空终止消息的 Agent 调用
- **触发条件**：已有报告后收到空终止消息

**解决方案**：

**方案1（推荐）**：回退到最后一条有效文本

\`\`\`ts
return terminalMessage.text || lastText;
\`\`\`

**方案2**：忽略空终止消息

\`\`\`ts
if (terminalMessage.text) return terminalMessage.text;
return previousReport;
\`\`\`

**预防措施**：

- 增加空终止消息测试
- 统一最终文本选择逻辑`;
    const header = '<!-- reviewx-decision: {"verdict":"NEW","severity":"minor"} -->';
    const publishedMarkdown = `${markdown}\n\nI need to fix a typo. Let me regenerate the code block cleanly.`;
    const document = `${header}\n\n${publishedMarkdown}`;
    const rawDocument = `I have sufficient evidence.\n\n${document}`;
    const runner = new AgentRunner(() => success(rawDocument));
    const client = new OpenCodeClient(runner, "fake", "./opencode");

    await expect(
      client.runJudge(artifactRoot, inputPaths, runOptions("judge")),
    ).resolves.toEqual({
      decision: { verdict: "NEW", severity: "minor" },
      markdown: publishedMarkdown,
      document,
    });

    const files = runner.calls[0]!.args.filter((value) => value === "--file");
    expect(files).toHaveLength(4);
    expect(JSON.parse(await readFile(path.join(artifactRoot, "judge", "decision.json"), "utf8")))
      .toEqual({ verdict: "NEW", severity: "minor" });
    expect(await readFile(path.join(artifactRoot, "judge", "comment.md"), "utf8"))
      .toBe(publishedMarkdown);
    expect(await readFile(path.join(artifactRoot, "judge", "report.md"), "utf8"))
      .toBe(document);
    expect(await readFile(path.join(artifactRoot, "judge", "attempt-1", "report.md"), "utf8"))
      .toBe(rawDocument);
    expect(JSON.parse(await readFile(
      path.join(artifactRoot, "judge", "input-manifest.json"),
      "utf8",
    )).files).toHaveLength(4);
  });

  it("retries one invalid Judge header and succeeds on the second fresh call", async () => {
    const runner = new AgentRunner((_agent, call) =>
      call === 1
        ? success("# Missing header")
        : success('<!-- reviewx-decision: {"verdict":"PASS"} -->'),
    );
    const client = new OpenCodeClient(runner, "fake", "./opencode");

    await expect(client.runJudge(artifactRoot, inputPaths, runOptions("retry")))
      .resolves.toMatchObject({ decision: { verdict: "PASS" } });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]!.args.at(-1)).toContain("上一次输出");
    expect(await readFile(
      path.join(artifactRoot, "retry", "attempt-1", "decision-error.txt"),
      "utf8",
    )).toContain("reviewx-decision");
    expect(JSON.parse(await readFile(
      path.join(artifactRoot, "retry", "metadata.json"),
      "utf8",
    ))).toMatchObject({ status: "succeeded", attempts: 2, verdict: "PASS" });
  });

  it("fails after one retry and attributes the final Markdown to the Judge", async () => {
    const runner = new AgentRunner(() => success("# Still invalid"));
    const client = new OpenCodeClient(runner, "fake", "./opencode");

    await expect(client.runJudge(artifactRoot, inputPaths, runOptions("invalid")))
      .rejects.toMatchObject({
        message: expect.stringMatching(/invalid decision document after one retry.*reviewx-decision/u),
        details: {
          agent: "review-judge",
          agent_output: "# Still invalid",
          agent_output_source: "assistant_text",
          agent_output_truncated: false,
        },
      });
    expect(runner.calls).toHaveLength(2);
    expect(JSON.parse(await readFile(
      path.join(artifactRoot, "invalid", "metadata.json"),
      "utf8",
    ))).toMatchObject({ status: "failed", attempts: 2, decision_status: "failed" });
  });

  it.each([
    [{ exitCode: 4, signal: null, stdout: "", stderr: "forbidden" }, "exit code 4"],
    [{ exitCode: 0, signal: null, stdout: "not-jsonl\n", stderr: "" }, "invalid event output"],
  ] as const)("does not retry process or event failure", async (result, message) => {
    const runner = new AgentRunner(() => result);
    const client = new OpenCodeClient(runner, "fake", "./opencode");
    await expect(client.runJudge(artifactRoot, inputPaths, runOptions("process-failure")))
      .rejects.toThrowError(new RegExp(message, "u"));
    expect(runner.calls).toHaveLength(1);
  });

  it("constructs with the packaged default configuration", () => {
    expect(new OpenCodeClient()).toBeInstanceOf(OpenCodeClient);
  });
});
