export interface SessionLogEntry {
  line: number;
  timestamp: string | null;
  level: "INFO" | "ERROR" | null;
  body: string;
}

const headerPattern = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[(INFO|ERROR)\](?=\s|$)/u;

export function parseSessionLog(text: string): SessionLogEntry[] {
  const entries: SessionLogEntry[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] + (index < lines.length - 1 ? "\n" : "");
    if (!line) continue;
    const header = headerPattern.exec(line);
    if (header) {
      entries.push({ line: index, timestamp: header[1], level: header[2] as "INFO" | "ERROR", body: line.slice(header[0].length) });
      continue;
    }
    const previous = entries.at(-1);
    // The logger indents diagnostic continuations. Unrecognized top-level lines
    // stay neutral instead of inheriting the preceding record's severity.
    if (previous && (previous.level === null || /^\s/u.test(line))) {
      previous.body += line;
    } else {
      entries.push({ line: index, timestamp: null, level: null, body: line });
    }
  }
  return entries;
}
