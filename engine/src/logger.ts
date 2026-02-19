export type LogLevel = "debug" | "info" | "warn" | "error";

type LogData = Record<string, unknown>;

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLogLevel(level?: string): LogLevel {
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    return level;
  }
  return "info";
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return error;
}

export class Logger {
  private readonly minLevel: LogLevel;

  constructor(level?: string) {
    this.minLevel = normalizeLogLevel(level);
  }

  debug(event: string, data?: LogData): void {
    this.log("debug", event, data);
  }

  info(event: string, data?: LogData): void {
    this.log("info", event, data);
  }

  warn(event: string, data?: LogData): void {
    this.log("warn", event, data);
  }

  error(event: string, data?: LogData): void {
    this.log("error", event, data);
  }

  private log(level: LogLevel, event: string, data?: LogData): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minLevel]) {
      return;
    }

    const safeData: LogData | undefined = data
      ? Object.fromEntries(
          Object.entries(data).map(([key, value]) => [key, serializeError(value)]),
        )
      : undefined;

    const payload = {
      ts: new Date().toISOString(),
      level,
      event,
      data: safeData,
    };

    const line = JSON.stringify(payload);

    if (level === "error") {
      process.stderr.write(`${line}\n`);
      return;
    }

    process.stdout.write(`${line}\n`);
  }
}

export const logger = new Logger(process.env.LOG_LEVEL);
