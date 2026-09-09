import { afterEach, describe, expect, test, vi } from "vitest";
import { createPreviewDataSource } from "@/src/client/review-data";
import { createReviewPreviewData } from "@/src/preview/mr-fixtures";
import { attemptStatusValues, findingStatusValues, severityValues } from "@/src/shared/types";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("fixed MR preview", () => {
  test("covers all statuses, reviewing phases and completed outcomes in a deterministic order", () => {
    const data = createReviewPreviewData();
    const rows = data.state.projects.flatMap(project => project.mergeRequests);
    expect(data.state.projects).toHaveLength(2);
    expect(rows).toHaveLength(14);
    expect(new Set(rows.map(row => row.status))).toEqual(new Set(["unreviewed", ...attemptStatusValues]));
    expect(rows.filter(row => row.status === "reviewing").map(row => row.phase)).toEqual([
      "understanding_changes", "verifying_findings", "finalizing_review",
    ]);
    const completed = rows.filter(row => row.status === "completed").map(row => data.details[`${row.projectId}/${row.iid}`].attempts[0]);
    expect(completed.map(attempt => attempt.result)).toEqual(["pass", "findings"]);
    expect(completed[0].findings).toEqual([]);
    expect(completed[1].findings.map(finding => finding.status)).toEqual(["published", "dismissed", "published", "dismissed"]);
    expect(new Set(rows.map(row => row.updatedAt)).size).toBe(14);
    expect(new Set(rows.map(row => row.sourceBranch)).size).toBe(14);
    expect(new Set(rows.map(row => row.targetBranch)).size).toBe(2);
    expect(Math.max(...rows.map(row => row.title.length)) - Math.min(...rows.map(row => row.title.length))).toBeGreaterThan(20);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2035-01-01T00:00:00Z"));
    expect(createReviewPreviewData()).toEqual(data);
  });

  test("every card resolves to its own detail, ordered history and complete reports", () => {
    const data = createReviewPreviewData();
    const keys: string[] = [];
    const ids: string[] = [];
    const reportUrls: string[] = [];
    for (const project of data.state.projects) for (const row of project.mergeRequests) {
      const key = `${project.id}/${row.iid}`;
      keys.push(key);
      const detail = data.details[key];
      expect(detail.project).toEqual({ id: project.id, name: project.name, registered: true });
      expect(row).toMatchObject(detail.mergeRequest);
      if (row.status === "unreviewed") {
        expect(detail.attempts).toEqual([]);
        expect(row.latestAttemptId).toBeUndefined();
        continue;
      }
      expect(detail.attempts).toHaveLength(3);
      expect(detail.attempts[0]).toMatchObject({ id: row.latestAttemptId, updatedAt: row.updatedAt, status: row.status, phase: row.phase });
      const dates = detail.attempts.map(attempt => attempt.createdAt);
      expect(dates).toEqual([...dates].sort().reverse());
      for (const [index, attempt] of detail.attempts.entries()) {
        ids.push(attempt.id);
        expect(attempt).toMatchObject({ projectId: project.id, mrIid: row.iid, mrTitle: row.title, sourceBranch: row.sourceBranch, targetBranch: row.targetBranch });
        if (index > 0) expect(attempt.status).toBe("archived");
        if (attempt.result) {
          expect(attempt.reportUrl).toBeDefined();
          const url = attempt.reportUrl!;
          reportUrls.push(url);
          const report = data.reports[url];
          expect(report).toContain(`# MR !${row.iid} · 检视报告`);
          expect(report).toContain(attempt.id);
          expect(report).toContain(attempt.sourceBranch);
          expect(report).toContain("| 项目 | 内容 |");
          expect(report).toContain("```text\nsource:");
          expect(report).toContain("## 检视局限");
          for (const finding of attempt.findings) expect(report).toContain(finding.body);
        }
      }
    }
    expect(new Set(keys).size).toBe(14);
    expect(Object.keys(data.details).sort()).toEqual(keys.sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(data.reports).sort()).toEqual(reportUrls.sort());
  });

  test("includes all finding severities, decisions, diagnostic text and legacy history", () => {
    const attempts = Object.values(createReviewPreviewData().details).flatMap(detail => detail.attempts);
    const findings = attempts.flatMap(attempt => attempt.findings);
    expect(new Set(findings.map(finding => finding.severity))).toEqual(new Set(severityValues));
    expect(new Set(findings.map(finding => finding.status))).toEqual(new Set(findingStatusValues));
    expect(findings.some(finding => finding.confidence === undefined)).toBe(true);
    expect(attempts.find(attempt => attempt.status === "review_failed")?.error?.stderr).toContain("\n");
    expect(attempts.find(attempt => attempt.status === "publish_failed")?.error?.technicalDetails).toContain("503");
    const publishing = attempts.find(attempt => attempt.status === "publishing")!;
    expect(publishing.publishBatches[0]).toMatchObject({ status: "running", currentOrdinal: 2, selectedOrdinals: [2] });
    for (const finding of findings) {
      if (finding.status === "failed" || finding.status === "unknown") expect(finding.error?.cause).toBeTruthy();
      for (const evidence of finding.evidence ?? []) expect(finding.body).toContain(`${evidence.path}:${evidence.startLine}–${evidence.endLine}`);
    }
  });

  test("memory source isolates reads and refuses network access for reads, writes and missing examples", async () => {
    const network = vi.fn(() => { throw new Error("Unexpected network access"); });
    vi.stubGlobal("fetch", network);
    const original = createReviewPreviewData();
    const baseline = structuredClone(original);
    const source = createPreviewDataSource(original);
    expect(source.readOnly).toBe(true);
    original.state.projects.splice(0);
    original.details["202/602"].attempts[0].findings[0].body = "changed input";
    const state = await source.readState();
    state.projects[0].mergeRequests.reverse();
    const detail = await source.readMr("202", "602");
    detail.attempts[0].findings[0].evidence![0].path = "changed output";
    const url = baseline.details["202/602"].attempts[0].reportUrl!;
    expect(await source.readReport(url)).toBe(baseline.reports[url]);
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const result = await source.mutate("/api/projects", method, { projectId: "999" });
      expect(result).toEqual(baseline.state);
      result.projects.splice(0);
    }
    await expect(source.readMr("999", "999")).rejects.toThrow("预览中没有该 MR。");
    await expect(source.readReport("/api/reports/missing")).rejects.toThrow("预览中没有该报告。");
    expect(await source.readState()).toEqual(baseline.state);
    expect(await source.readMr("202", "602")).toEqual(baseline.details["202/602"]);
    expect(createReviewPreviewData()).toEqual(baseline);
    expect(network).not.toHaveBeenCalled();
  });
});
