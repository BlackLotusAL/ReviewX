import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CodeHubClient } from "@/src/server/codehub";
import { OpenCodeReviewer } from "@/src/server/opencode";
import type { MergeRequestSnapshot } from "@/src/shared/types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function shimEnvironment(root: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
    Path: `${root}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}`,
  };
}

describe.runIf(process.platform === "win32")("real PowerShell adapters for external clients", () => {
  test("CodeHub uses only the four exact PRD command shapes and passes one real-CRLF body argv", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-codehub-shim-"));
    roots.push(root);
    const capture = path.join(root, "calls.jsonl");
    const script = [
      "$utf8 = [Text.UTF8Encoding]::new($false)",
      "$line = ConvertTo-Json -Compress -InputObject ([object[]]$args)",
      "[IO.File]::AppendAllText($env:CODEHUB_CAPTURE, $line + [Environment]::NewLine, $utf8)",
      "if ($args[0] -eq 'repo') { [Console]::Out.Write('{\"repo_id\":\"101\",\"clone_urls\":{\"https\":\"https://codehub.example/team/repo.git\"}}'); exit 0 }",
      "if ($args[1] -eq 'list') { [Console]::Out.Write('[{\"iid\":\"7\",\"title\":\"Example MR\"}]'); exit 0 }",
      "if ($args[1] -eq 'view') { if ($env:CODEHUB_BAD_WEB_URL -eq '1') { [Console]::Out.Write('{\"repo_id\":\"101\",\"iid\":\"7\",\"state\":\"opened\",\"source_branch\":\"feature\",\"target_branch\":\"main\",\"updated_at\":\"2026-09-02T00:00:00Z\"}'); exit 0 }; [Console]::Out.Write('{\"repo_id\":\"101\",\"iid\":\"7\",\"title\":\"Example MR\",\"state\":\"opened\",\"source_branch\":\"feature\",\"target_branch\":\"main\",\"updated_at\":\"2026-09-02T00:00:00Z\",\"web_url\":\"https://codehub.example/team/repo/merge_requests/7\"}'); exit 0 }",
      "if ($args[1] -eq 'comment') { [Console]::Out.Write('{\"comment_id\":\"comment-1\",\"repo_id\":\"101\",\"mr_iid\":\"7\",\"severity\":\"major\"}'); exit 0 }",
      "exit 9",
    ].join("\n");
    await writeFile(path.join(root, "codehub.ps1"), script, "utf8");
    const client = new CodeHubClient(shimEnvironment(root, { CODEHUB_CAPTURE: capture }));

    await expect(client.viewRepo("101")).resolves.toEqual({ cloneUrl: "https://codehub.example/team/repo.git", name: "team/repo" });
    await expect(client.listOpenMrs("101")).resolves.toEqual([{ iid: "7", title: "Example MR" }]);
    await expect(client.viewMr("101", "7")).resolves.toMatchObject({
      projectId: "101",
      iid: "7",
      state: "opened",
      sourceBranch: "feature",
      targetBranch: "main",
      webUrl: "https://codehub.example/team/repo/merge_requests/7",
    });
    await expect(client.createComment("101", "7", "first\nsecond\rthird\r\nfourth", "major")).resolves.toMatchObject({ kind: "success" });
    const incompatibleClient = new CodeHubClient(shimEnvironment(root, { CODEHUB_CAPTURE: capture, CODEHUB_BAD_WEB_URL: "1" }));
    await expect(incompatibleClient.viewMr("101", "7")).rejects.toMatchObject({
      code: "CODEHUB_INVALID_RESPONSE",
      nextStep: expect.stringContaining("升级"),
    });

    const calls = (await readFile(capture, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as string[]);
    expect(calls).toEqual([
      ["repo", "view", "101", "--output", "json"],
      ["mr", "list", "--project-id", "101", "--state", "open", "--output", "json"],
      ["mr", "view", "7", "--project-id", "101", "--output", "json"],
      ["mr", "comment", "create", "7", "--project-id", "101", "--body", "first\r\nsecond\r\nthird\r\nfourth", "--severity", "major", "--output", "json"],
      ["mr", "view", "7", "--project-id", "101", "--output", "json"],
    ]);
  }, 10_000);

  test("OpenCode runs exactly once with stdin prompt, attached bundle, denied tools, and stripped repository credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-opencode-shim-"));
    roots.push(root);
    const capture = path.join(root, "calls.jsonl");
    const bundle = path.join(root, "review-bundle.txt");
    await writeFile(bundle, "safe bundle", "utf8");
    const script = [
      "$utf8 = [Text.UTF8Encoding]::new($false)",
      "$stdin = [Console]::In.ReadToEnd()",
      "$record = [ordered]@{ arguments = [object[]]$args; stdin = $stdin; codehub = $env:CODEHUB_TOKEN; git = $env:GIT_TOKEN; gh = $env:GH_TOKEN; github = $env:GITHUB_TOKEN; ssh = $env:SSH_AUTH_SOCK; config = $env:OPENCODE_CONFIG_CONTENT; disable_plugins = $env:OPENCODE_DISABLE_DEFAULT_PLUGINS }",
      "$line = ConvertTo-Json -Compress -Depth 8 -InputObject $record",
      "[IO.File]::AppendAllText($env:REVIEWX_CAPTURE, $line + [Environment]::NewLine, $utf8)",
      "$body = '{\"findings\":[{\"severity\":\"minor\",\"body\":\"A finding\"}]}'",
      "$event = @{ type = 'text'; part = @{ type = 'text'; text = $body } } | ConvertTo-Json -Compress -Depth 5",
      "[Console]::Out.WriteLine($event)",
    ].join("\n");
    await writeFile(path.join(root, "opencode.ps1"), script, "utf8");
    const environment = shimEnvironment(root, {
      REVIEWX_CAPTURE: capture,
      CODEHUB_TOKEN: "codehub-secret-value",
      GIT_TOKEN: "git-secret-value",
      GH_TOKEN: "gh-secret-value",
      GITHUB_TOKEN: "github-secret-value",
      SSH_AUTH_SOCK: "ssh-secret-value",
    });
    const reviewer = new OpenCodeReviewer(environment);
    const details: MergeRequestSnapshot = {
      projectId: "101", iid: "7", title: "MR", state: "open", updatedAt: "2026-09-02T00:00:00Z",
      sourceBranch: "feature", targetBranch: "main",
    };
    const prepared = {
      rootDirectory: root,
      sourceDirectory: root,
      patchPath: path.join(root, "changes.patch"),
      bundlePath: bundle,
      sourceSha: "1".repeat(40),
      targetSha: "2".repeat(40),
      cleanup: async () => undefined,
    };

    await expect(reviewer.review("101", details, prepared, new AbortController().signal)).resolves.toEqual({
      findings: [{ severity: "minor", body: "A finding" }],
    });
    const records = (await readFile(capture, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0].arguments).toEqual(["run", "--format", "json", "--pure", "--agent", "reviewx", "--file", bundle, "--dir", root]);
    expect(records[0].stdin).toContain("Return only specific, actionable findings");
    expect(String(records[0].stdin)).not.toContain("secret-value");
    for (const key of ["codehub", "git", "gh", "github", "ssh"]) expect(records[0][key]).toBeNull();
    const config = JSON.parse(String(records[0].config)) as { agent: { reviewx: { permission: Record<string, string> } } };
    expect(config.agent.reviewx.permission).toEqual({ "*": "deny" });
    expect(records[0].disable_plugins).toBe("true");
  });
});
