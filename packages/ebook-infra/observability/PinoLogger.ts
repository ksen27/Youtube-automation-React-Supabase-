import pino from 'pino';
import type { Logger } from '@ebook/core';

export class PinoLogger implements Logger {
  constructor(private readonly logger: pino.Logger) {}

  static create(level = 'info'): PinoLogger {
    return new PinoLogger(pino({ level }));
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.logger.debug(meta ?? {}, msg);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.logger.info(meta ?? {}, msg);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.logger.warn(meta ?? {}, msg);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.logger.error(meta ?? {}, msg);
  }
  child(bindings: Record<string, unknown>): Logger {
    return new PinoLogger(this.logger.child(bindings));
  }
}
