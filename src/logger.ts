import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { LogRecord } from "./contracts.js";
import { ReviewXError } from "./errors.js";

export type LogInput = Omit<LogRecord, "time"> & { time?: string };

export class JsonlLogger {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly logPath: string,
    private readonly writeStdout: (line: string) => void = (line) => {
      process.stdout.write(line);
    },
  ) {}

  write(input: LogInput): Promise<void> {
    const record: LogRecord = {
      ...input,
      time: input.time ?? new Date().toISOString(),
    };
    const line = `${JSON.stringify(record)}\n`;
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(path.dirname(this.logPath), { recursive: true });
        await appendFile(this.logPath, line, "utf8");
        this.writeStdout(line);
      } catch (error) {
        throw new ReviewXError("LOG_ERROR", `Unable to write log file: ${this.logPath}`, {
          cause: error,
        });
      }
    });
    return this.queue;
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}
