/** Stable content hashing for idempotency keys (sha256 of canonical JSON). */
export interface Hasher {
  hash(input: unknown): string;
}
