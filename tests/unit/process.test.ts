import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveCommand } from "@/src/cli/resolve-command";
import { runProcess, type ResolvedCommand } from "@/src/server/process";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("shell-free child processes", () => {
  test("native process preserves hostile-looking argv and stdin without shell execution", async () => {
    const command: ResolvedCommand = { name: "node", executable: process.execPath, prefixArgs: [] };
    const marker = path.join(os.tmpdir(), `reviewx-should-not-exist-${Date.now()}`);
    const values = ["line\nnext", "\"quoted\"", "$(touch x)", `; ${marker}`, "\\path\\"];
    const result = await runProcess(command, ["-e", "process.stdin.on('data',d=>process.stdout.write(JSON.stringify({a:process.argv.slice(1),i:d.toString()})))", ...values], {
      timeoutMs: 5_000,
      input: "stdin-value",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ a: values, i: "stdin-value" });
  });

  test.runIf(process.platform === "win32")("PowerShell JSON envelope preserves multiline UTF-8 arguments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-ps-envelope-"));
    roots.push(root);
    await writeFile(path.join(root, "fake.ps1"), "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n[Console]::Out.Write(($args | ConvertTo-Json -Compress))\n", "utf8");
    const environment = { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`, Path: `${root}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}` };
    const command = await resolveCommand("fake", environment);
    const args = ["中文\r\nsecond", "tab\tquote\"slash\\"];
    const result = await runProcess(command, args, { timeoutMs: 10_000, env: environment });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.replace(/^\uFEFF/u, ""))).toEqual(args);
  });

  test("abort terminates a running child exactly once", async () => {
    const command: ResolvedCommand = { name: "node", executable: process.execPath, prefixArgs: [] };
    const controller = new AbortController();
    const running = runProcess(command, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 30_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await running;
    expect(result.started).toBe(true);
    expect(result.aborted).toBe(true);
  });
});
