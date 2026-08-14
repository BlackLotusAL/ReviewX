import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlLogger } from "../../src/logger.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("JSONL logger", () => {
  it("writes byte-identical ordered lines to file and stdout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-log-"));
    roots.push(root);
    const output: string[] = [];
    const target = path.join(root, "nested", "events.jsonl");
    const logger = new JsonlLogger(target, (line) => output.push(line));
    await Promise.all([
      logger.write({ time: "one", level: "info", event: "scan_started" }),
      logger.write({ time: "two", level: "info", event: "scan_finished" }),
    ]);
    await logger.flush();
    expect(output.join("")).toBe(await readFile(target, "utf8"));
    expect(output.map((line) => JSON.parse(line).time)).toEqual(["one", "two"]);
  });

  it("turns append failures into LOG_ERROR", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-log-"));
    roots.push(root);
    const directory = path.join(root, "is-a-directory");
    await mkdir(directory);
    const logger = new JsonlLogger(directory, () => {});
    await expect(logger.write({ level: "error", event: "runtime_error" })).rejects.toMatchObject({
      code: "LOG_ERROR",
    });
  });
});
