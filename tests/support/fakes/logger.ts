import type { LoggerProvider } from "../../../src/providers/index.ts";

type LogEntry = {
  message: string;
  attributes: Record<string, unknown> | undefined;
};

export class RecordingLogger implements LoggerProvider {
  infoCalls: LogEntry[] = [];
  warnCalls: LogEntry[] = [];
  errorCalls: LogEntry[] = [];

  info(message: string, attributes?: Record<string, unknown>): void {
    this.infoCalls.push({ message, attributes });
  }

  warn(message: string, attributes?: Record<string, unknown>): void {
    this.warnCalls.push({ message, attributes });
  }

  error(message: string, attributes?: Record<string, unknown>): void {
    this.errorCalls.push({ message, attributes });
  }
}
