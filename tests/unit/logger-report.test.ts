import { fakeResult } from "../helpers/runtime";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { MergeRequestSnapshot, ReviewAttempt } from "@/src/shared/types";
import { AppError } from "@/src/server/errors";
import { createLogFile, localTimestamp, Logger } from "@/src/server/platform/logger";
import { ensureDataPaths, resolveDataPaths } from "@/src/server/platform/paths";
import { ReportStore } from "@/src/server/storage/report-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function paths() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-log-report-"));
  roots.push(root);
  const value = resolveDataPaths({ LOCALAPPDATA: root });
  ensureDataPaths(value);
  return value;
}

describe("permanent logs and immutable reports", () => {
  test("logger emits English diagnostics once and redacts credentials/control characters", async () => {
    const data = await paths();
    const token = "super-secret-value";
    const privateKeyBody = "THIS-PRIVATE-KEY-MATERIAL-MUST-NOT-APPEAR";
    const privateKeyType = "RSA";
    const file = createLogFile(data, new Date(2026, 8, 2, 8, 9, 10, 11));
    const logger = new Logger(file, { CODEHUB_TOKEN: token }, () => new Date(2026, 8, 2, 8, 9, 10, 11));
    logger.info({ projectId: "1", mrIid: "2", mrTitle: "bad\nline" }, `Using ${token}`);
    logger.error({ projectId: "1" }, new AppError({
      code: "X", message: "Operation failed.", reason: `Bearer ${token}`, impact: "Nothing changed.", nextStep: "Retry manually.", technical: "exit 7", stderr: `\u001b[31mfail\n-----BEGIN ${privateKeyType} PRIVATE KEY-----\n${privateKeyBody}\n-----END ${privateKeyType} PRIVATE KEY-----\nsecond`,
    }));
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(token);
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain(privateKeyBody);
    expect(text).toContain("bad\\nline");
    expect(text).toContain("Cause:");
    expect(text).toContain("Impact:");
    expect(text).toContain("Next step:");
    expect(text).toContain("Technical details:");
    expect(localTimestamp(new Date(2026, 8, 2, 8, 9, 10, 11))).toMatch(/^2026-09-02 08:09:10\.011$/u);
  });

  test("each successful attempt gets one immutable report and traversal reads are rejected", async () => {
    const data = await paths();
    const store = new ReportStore(data);
    const attempt: ReviewAttempt = { id: "attempt-1", projectId: "1", mrIid: "2", mrTitle: "MR", requestedUpdatedAt: "v", status: "reviewing", createdAt: "now", findings: [], publishBatches: [] };
    const mr: MergeRequestSnapshot = { projectId: "1", iid: "2", title: "MR", state: "open", updatedAt: "v", sourceBranch: "feature", targetBranch: "main" };
    const prepared = { sourceSha: "1".repeat(40), targetSha: "2".repeat(40), baseSha: "3".repeat(40) };
    const result = fakeResult([{ severity: "minor", body: "### 🟡 Minor: Issue\n\nBody" }]);
    result.execution!.progress.limitations = ["跳过不支持变更：image.bin（二进制）。"];
    const pathValue = await store.save(attempt, mr, prepared, result);
    expect(await store.read(pathValue)).toContain("Attempt ID");
    expect(await store.read(pathValue)).toContain("跳过不支持变更：image.bin（二进制）。");
    expect(await store.save(attempt, mr, prepared, result)).toBe(pathValue);
    expect(await Promise.all([store.save({ ...attempt, id: "race" }, mr, prepared, result), store.save({ ...attempt, id: "race" }, mr, prepared, result)])).toEqual(["reports/race/report.md", "reports/race/report.md"]);
    const partial = fakeResult([]); partial.submission.completion = "incomplete";
    const partialPath = await store.save({ ...attempt, id: "partial" }, mr, prepared, partial);
    expect(await store.read(partialPath)).toContain("**PARTIAL**");
    expect(await store.read(partialPath)).not.toContain("**PASS**");
    await mkdir(path.join(data.reports, "broken"));
    await writeFile(path.join(data.reports, "broken/report.md"), "incomplete");
    await expect(store.save({ ...attempt, id: "broken" }, mr, prepared, result)).rejects.toMatchObject({ code: "REPORT_WRITE_ERROR" });
    await expect(store.save(attempt, mr, prepared, fakeResult([]))).rejects.toMatchObject({ code: "REPORT_WRITE_ERROR" });
    await expect(store.read("../outside.txt")).rejects.toMatchObject({ code: "UNSAFE_FILE_PATH" });
  });
});
