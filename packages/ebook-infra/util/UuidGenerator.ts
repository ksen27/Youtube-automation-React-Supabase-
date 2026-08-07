import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '@ebook/core';

export class UuidGenerator implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }
}
