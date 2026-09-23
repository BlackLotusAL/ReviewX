import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveCommand } from "@/src/server/platform/resolve-command";
import { runProcess, type ResolvedCommand } from "@/src/server/platform/process";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("shell-free child processes", () => {
  const node: ResolvedCommand = { name: "node", executable: process.execPath, prefixArgs: [] };

  test("tail shares its byte budget across streams and still delivers all callbacks", async () => {
    let stdout = "", stderr = "";
    const result = await runProcess(node, ["-e", "process.stdout.write('a'.repeat(100000)); process.stdin.once('data',()=>process.stderr.write('TAIL'));"], {
      timeoutMs: 5000, outputMode: "tail", maxOutputBytes: 16,
      // Use a separate test below for cross-stream ordering; here both callbacks must be complete.
      input: "continue",
      onStdout: chunk => { stdout += chunk; }, onStderr: chunk => { stderr += chunk; },
    });
    expect(result.exitCode).toBe(0);
    expect(result.outputLimitExceeded).toBe(false);
    expect(stdout).toBe("a".repeat(100000));
    expect(stderr).toBe("TAIL");
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(16);
  });

  test("tail preserves the latest output and evicts older stream data", async () => {
    const result = await runProcess(node, ["-e", "process.stdout.write('old'); setTimeout(()=>process.stderr.write('abcdefgh'),100); setTimeout(()=>process.stdout.write('END'),250);"], {
      timeoutMs: 5000, outputMode: "tail", maxOutputBytes: 8,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "END", stderr: "defgh", outputLimitExceeded: false });
  });

  test("tail handles a large output chunk without retaining its prefix", async () => {
    const result = await runProcess(node, ["-e", "process.stdout.write('x'.repeat(100000)+'THE-END');"], { timeoutMs: 5000, outputMode: "tail", maxOutputBytes: 7 });
    expect(result).toMatchObject({ exitCode: 0, stdout: "THE-END", outputLimitExceeded: false });
  });

  test("full output still terminates on overflow", async () => {
    const result = await runProcess(node, ["-e", "process.stdout.write('x'.repeat(100000)); setInterval(()=>{},1000);"], { timeoutMs: 5000, maxOutputBytes: 16 });
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  test.each(["timeout", "abort"])("tail still terminates on %s", async kind => {
    const controller = new AbortController();
    const running = runProcess(node, ["-e", "setInterval(()=>process.stdout.write('log'),10);"], {
      timeoutMs: kind === "timeout" ? 150 : 5000, outputMode: "tail", maxOutputBytes: 8, signal: controller.signal,
    });
    const timer = kind === "abort" ? setTimeout(() => controller.abort(), 150) : undefined;
    const result = await running;
    clearTimeout(timer);
    expect(result[kind === "timeout" ? "timedOut" : "aborted"]).toBe(true);
    expect(result.outputLimitExceeded).toBe(false);
  });

  test.each([{ binaryOutput: true }, { stdoutFile: "unused" }])("tail rejects incompatible output options: %j", async extra => {
    await expect(runProcess(node, [], { timeoutMs: 5000, outputMode: "tail", ...extra })).rejects.toThrow("Tail output cannot be combined");
  });

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
