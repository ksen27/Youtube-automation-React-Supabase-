import type { Clock } from '@ebook/core';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
