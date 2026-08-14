import { describe, expect, it } from "vitest";
import { errorMessage, redactText } from "../../src/errors.js";
import { DefaultCommandRunner } from "../../src/process.js";
import { assertPathWithin, createRuntimePaths } from "../../src/runtime.js";

describe("process, redaction, and runtime paths", () => {
  it("captures stdout and stderr from an argument-array process", async () => {
    const result = await new DefaultCommandRunner().run(
      process.execPath,
      ["-e", "process.stdout.write('out');process.stderr.write('err')"],
      { timeoutMs: 5_000 },
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "out", stderr: "err" });
  });

  it("enforces timeout and pre-aborted signals", async () => {
    await expect(
      new DefaultCommandRunner().run(process.execPath, ["-e", "setTimeout(()=>{},5000)"], {
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      new DefaultCommandRunner().run(process.execPath, ["-e", ""], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "PROCESS_ABORTED" });
  });

  it("handles active aborts, start failures, nonzero exits, and output limits", async () => {
    const controller = new AbortController();
    const active = new DefaultCommandRunner().run(
      process.execPath,
      ["-e", "setTimeout(()=>{},5000)"],
      { signal: controller.signal, timeoutMs: 5_000 },
    );
    setTimeout(() => controller.abort(), 20);
    await expect(active).rejects.toMatchObject({ code: "PROCESS_ABORTED" });
    await expect(new DefaultCommandRunner().run("reviewx-command-that-does-not-exist", []))
      .rejects.toMatchObject({ code: "PROCESS_ERROR" });
    await expect(
      new DefaultCommandRunner().run(process.execPath, ["-e", "process.stdout.write('12345')"], {
        maxOutputBytes: 3,
      }),
    ).rejects.toMatchObject({ code: "PROCESS_ERROR" });
    await expect(
      new DefaultCommandRunner().run(process.execPath, ["-e", "process.exit(7)"]),
    ).resolves.toMatchObject({ exitCode: 7 });
  });

  it("redacts credentials and rejects broad deletion targets", () => {
    expect(redactText("https://user:pass@example.test token=abc private-token: xyz")).toBe(
      "https://***@example.test token=*** private-token=***",
    );
    const paths = createRuntimePaths("runtime/custom.json");
    expect(paths.log.endsWith("runtime\\reviewx.jsonl") || paths.log.endsWith("runtime/reviewx.jsonl")).toBe(true);
    expect(() => assertPathWithin(paths.runs, paths.runs)).toThrow();
    expect(() => assertPathWithin(paths.runs, `${paths.runs}-outside`)).toThrow();
    expect(() => assertPathWithin(paths.runs, `${paths.runs}/child`)).not.toThrow();
    expect(errorMessage("plain")).toBe("plain");
  });
});
