import { describe, expect, it } from "vitest";
import {
  commitSchema,
  judgeDecisionSchema,
  mergeRequestSchema,
  normalizePositiveId,
  repositorySchema,
  severityToCodeHub,
  stateSchema,
} from "../../src/contracts.js";
import { parseDuration, parseInterval } from "../../src/duration.js";

describe("public contracts", () => {
  it("normalizes IDs and parses supported durations", () => {
    expect(normalizePositiveId("00042")).toBe("42");
    expect(parseDuration("500ms", "--agent-timeout")).toBe(500);
    expect(parseDuration("2s", "--agent-timeout")).toBe(2_000);
    expect(parseDuration("3m", "--agent-timeout")).toBe(180_000);
    expect(parseInterval("3m", "--interval")).toBe(180_000);
    expect(parseInterval("2h", "--interval")).toBe(7_200_000);
    expect(parseInterval("1d", "--interval")).toBe(86_400_000);
  });

  it.each(["0", "-1", "abc", "1.5"])("rejects invalid ID %s", (value) => {
    expect(() => normalizePositiveId(value)).toThrow();
  });

  it.each(["0s", "1h", "1.5s", "abc", "999999999999999999999m"])(
    "rejects invalid duration %s",
    (value) => expect(() => parseDuration(value, "--agent-timeout")).toThrow(),
  );

  it.each(["500ms", "5s", "0m", "1.5h", "abc", "999999999999999999999d"])(
    "rejects invalid interval %s",
    (value) => expect(() => parseInterval(value, "--interval")).toThrow(),
  );

  it("accepts CodeHub nullable descriptive metadata", () => {
    expect(
      repositorySchema.parse({
        repo_id: "1",
        full_name: null,
        clone_urls: { ssh: null, https: "https://example.test/repo.git" },
        archived: null,
        updated_at: null,
        default_branch: null,
        web_url: null,
      }),
    ).toMatchObject({ full_name: null, archived: null, updated_at: null });
    expect(
      mergeRequestSchema.parse({
        repo_id: "1",
        mr_id: null,
        iid: "2",
        title: null,
        state: "opened",
        is_draft: null,
        author: null,
        source_branch: "feature",
        target_branch: "main",
        updated_at: "2026-08-12T00:00:00Z",
        web_url: null,
      }),
    ).toMatchObject({ mr_id: null, title: null, is_draft: null });
    expect(
      commitSchema.parse({
        sha: null,
        title: null,
        message: null,
        author: null,
        committer: null,
        authored_at: null,
        committed_at: null,
        parent_shas: null,
      }),
    ).toMatchObject({ sha: null, title: null, message: null, parent_shas: null });
  });

  it.each(["repo_id", "iid", "state", "source_branch", "target_branch", "updated_at"])(
    "rejects a null operational MR field %s",
    (field) => {
      const mergeRequest = {
        repo_id: "1",
        mr_id: null,
        iid: "2",
        title: null,
        state: "opened",
        is_draft: null,
        author: null,
        source_branch: "feature",
        target_branch: "main",
        updated_at: "2026-08-12T00:00:00Z",
        web_url: null,
      };
      expect(() => mergeRequestSchema.parse({ ...mergeRequest, [field]: null })).toThrow();
    },
  );

  it("enforces the minimal strict Judge decision union", () => {
    expect(judgeDecisionSchema.parse({ verdict: "pass" })).toEqual({ verdict: "pass" });
    expect(
      judgeDecisionSchema.parse({ verdict: "duplicate_of", duplicate_comment_id: null }),
    ).toEqual({ verdict: "duplicate_of", duplicate_comment_id: null });
    expect(judgeDecisionSchema.parse({ verdict: "new", severity: "Critical" })).toEqual({
      verdict: "new",
      severity: "Critical",
    });
    expect(() => judgeDecisionSchema.parse({ verdict: "new" })).toThrow();
    expect(() => judgeDecisionSchema.parse({ verdict: "new", severity: "High" })).toThrow();
    expect(() => judgeDecisionSchema.parse({ verdict: "pass", explanation: "extra" })).toThrow();
  });

  it("accepts legacy and Markdown history while rejecting malformed state", () => {
    const state = stateSchema.parse({
      repositories: {
        "1": {
          merge_requests: {
            "2": {
              finding_history: [
                {
                  summary: { title: "Legacy", file: "a.ts", problem: "problem" },
                  publication_status: "confirmed",
                  comment_id: "old",
                },
                {
                  review_markdown: "# Current review",
                  publication_status: "unknown",
                  comment_id: null,
                },
              ],
            },
          },
        },
      },
    });
    expect(state.repositories["1"]!.merge_requests["2"]!.finding_history).toHaveLength(2);
    expect(() => stateSchema.parse({ repositories: {}, phase: "running" })).toThrow();
    expect(() =>
      stateSchema.parse({
        repositories: {
          "1": {
            merge_requests: {
              "2": {
                finding_history: [
                  { review_markdown: "", publication_status: "confirmed", comment_id: null },
                ],
              },
            },
          },
        },
      }),
    ).toThrow();
  });

  it("maps severity to CodeHub", () => {
    expect(severityToCodeHub).toEqual({
      Blocker: "fatal",
      Critical: "major",
      Major: "minor",
      Minor: "suggestion",
    });
  });
});
