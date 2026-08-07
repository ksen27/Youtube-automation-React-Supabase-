import { createHash } from 'node:crypto';
import type { Hasher } from '@ebook/core';

/** Stable JSON serialization (sorted keys) → sha256, for content-based idempotency. */
export class Sha256Hasher implements Hasher {
  hash(input: unknown): string {
    return createHash('sha256').update(stableStringify(input)).digest('hex');
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
