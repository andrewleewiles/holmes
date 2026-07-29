export type EditorLogLevel = "log" | "info" | "warn" | "error";

export type EditorLogCategory = "socket" | "download" | "worker" | "operation";

export type EditorLogEntry = {
  id: number;
  time: string;
  level: EditorLogLevel;
  category: EditorLogCategory;
  message: string;
  details: unknown[];
};

type ConsoleMethod = (...args: unknown[]) => void;

export class EditorLogger {
  private entries: EditorLogEntry[] = [];
  private nextId = 1;

  constructor(private readonly editorId: string) {}

  private getConsoleMethod(level: EditorLogLevel): ConsoleMethod {
    return console[level] ?? console.log;
  }

  private write(
    level: EditorLogLevel,
    category: EditorLogCategory,
    message: string,
    details: unknown[],
    consoleArgs?: unknown[],
  ) {
    const entry: EditorLogEntry = {
      id: this.nextId++,
      time: new Date().toISOString(),
      level,
      category,
      message,
      details,
    };
    this.entries.push(entry);

    this.getConsoleMethod(level)(
      ...(consoleArgs ?? [
        `[OnlyOffice:${this.editorId}] [${category}] ${message}`,
        ...details,
      ]),
    );
  }

  log(category: EditorLogCategory, message: string, ...details: unknown[]) {
    this.write("log", category, message, details);
  }

  info(category: EditorLogCategory, message: string, ...details: unknown[]) {
    this.write("info", category, message, details);
  }

  warn(category: EditorLogCategory, message: string, ...details: unknown[]) {
    this.write("warn", category, message, details);
  }

  error(category: EditorLogCategory, message: string, ...details: unknown[]) {
    this.write("error", category, message, details);
  }

  raw(
    level: EditorLogLevel,
    category: EditorLogCategory,
    message: string,
    consoleArgs: unknown[],
    ...details: unknown[]
  ) {
    this.write(
      level,
      category,
      message,
      details.length > 0 ? details : consoleArgs,
      consoleArgs,
    );
  }

  socket(message: string, ...details: unknown[]) {
    this.log("socket", message, ...details);
  }

  download(message: string, ...details: unknown[]) {
    this.log("download", message, ...details);
  }

  worker(message: string, ...details: unknown[]) {
    this.log("worker", message, ...details);
  }

  operation(message: string, ...details: unknown[]) {
    this.log("operation", message, ...details);
  }

  getEntries() {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
  }

  print() {
    const title = `[OnlyOffice:${this.editorId}] editor logs (${this.entries.length})`;
    if (typeof console.groupCollapsed === "function") {
      console.groupCollapsed(title);
      const rows = this.entries.map(({ id, time, level, category, message }) => ({
        id,
        time,
        level,
        category,
        message,
      }));
      if (typeof console.table === "function") {
        console.table(rows);
      } else {
        console.log(rows);
      }
      this.entries.forEach((entry) => {
        this.getConsoleMethod(entry.level)(
          `#${entry.id} ${entry.time} [${entry.category}] ${entry.message}`,
          ...entry.details,
        );
      });
      console.groupEnd();
      return;
    }

    console.log(title, this.getEntries());
  }
}
