import { describe, expect, test } from "vitest";
import { parseSessionLog, type SessionLogEntry } from "@/src/shared/session-log";

function originalText(entries: SessionLogEntry[]) {
  return entries.map(entry => `${entry.timestamp === null ? "" : `[${entry.timestamp}] [${entry.level}]`}${entry.body}`).join("");
}

describe("session log presentation", () => {
  test("groups indented diagnostics with their record without changing the original text", () => {
    const text = "[2026-09-08 10:20:30.123] [INFO] [Project: demo (#101)] Starting.\r\n"
      + "[2026-09-08 10:20:31.456] [ERROR] Operation failed.\r\n"
      + "    Cause: Connection refused.\r\n    Stderr:\r\n      first line\r\n      second line\r\n\r\n"
      + "[2026-09-08 10:20:32.789] [INFO] Recovered.";
    const entries = parseSessionLog(text);
    expect(entries.map(entry => entry.level)).toEqual(["INFO", "ERROR", "INFO"]);
    expect(entries[1].body).toContain("    Stderr:\r\n      first line\r\n      second line");
    expect(originalText(entries)).toBe(text);
  });

  test("unrecognized lines and levels remain neutral and retain whitespace", () => {
    const text = "preamble\n  details\n[2026-09-08 10:20:30.123] [ERROR] Failed.\n"
      + "unknown record\n[2026-09-08 10:20:30.124] [WARN] Unrecognized level.\n"
      + "[broken time] [INFO] Not a known header.\n";
    const entries = parseSessionLog(text);
    expect(entries.map(entry => entry.level)).toEqual([null, "ERROR", null]);
    expect(entries[2].body).toContain("[WARN]");
    expect(originalText(entries)).toBe(text);
  });

  test("keeps partial final lines and markup-looking messages verbatim", () => {
    const text = "[2026-09-08 10:20:30.123] [INFO] <script>alert('log')</script> & <b>text</b>\n[2026-09";
    expect(originalText(parseSessionLog(text))).toBe(text);
    expect(parseSessionLog(text).at(-1)?.level).toBeNull();
    expect(parseSessionLog("")).toEqual([]);
    expect(originalText(parseSessionLog("\n \t\n"))).toBe("\n \t\n");
  });
});
