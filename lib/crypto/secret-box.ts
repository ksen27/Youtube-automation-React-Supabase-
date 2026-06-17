import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { getEnv } from "@/lib/env";

// Symmetric "secret box" for data we must store reversibly: HeyGen account
// passwords and serialized browser cookie/session state (heygen_accounts).
//
// These differ fundamentally from the access password in lib/auth.ts — that is
// one-way HASHED (we only ever compare, never recover). HeyGen credentials must
// be RECOVERED to drive the login automation, so they are ENCRYPTED with a key
// only the server holds (SECRET_BOX_KEY). Plaintext never touches the DB.
//
// Cipher: AES-256-GCM. GCM is authenticated — decryption fails loudly if the
// ciphertext was tampered with, rather than silently returning garbage that
// would then be typed into a login form.
//
// Wire format (base64 of the concatenation): [12B iv][16B authTag][ciphertext].
// Self-describing, so a single string round-trips through one Postgres column.

const IV_LENGTH = 12; // 96-bit nonce — the GCM-recommended size.
const AUTH_TAG_LENGTH = 16;
const ALGO = "aes-256-gcm";

// Derive a fixed 32-byte key from SECRET_BOX_KEY. We accept either a 64-char
// hex string (the documented `openssl rand -hex 32` form) or any other string,
// which we SHA-256 into 32 bytes. Throwing here is intentional: a misconfigured
// key must never silently degrade to weak/zero-key encryption.
function getKey(): Buffer {
  const raw = getEnv().SECRET_BOX_KEY;
  if (!raw) {
    throw new Error(
      "SECRET_BOX_KEY not configured — required to encrypt HeyGen credentials. " +
        "Generate one with: openssl rand -hex 32",
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  // Non-hex key: hash to a stable 32 bytes. Still strong, just less explicit.
  return createHash("sha256").update(raw).digest();
}

export function isSecretBoxConfigured(): boolean {
  return Boolean(getEnv().SECRET_BOX_KEY);
}

/** Encrypt a UTF-8 string. Returns base64 [iv | authTag | ciphertext]. */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** Reverse encryptSecret. Throws if the key is wrong or the payload is tampered. */
export function decryptSecret(payload: string): string {
  const key = getKey();
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("decryptSecret: ciphertext too short / corrupt");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// Convenience helpers for the JSON cookie/storage-state blob so callers don't
// re-stringify at every site. Returns null for null input so an account with
// no persisted session round-trips cleanly.
export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value));
}
export function decryptJson<T = unknown>(payload: string | null): T | null {
  if (!payload) return null;
  return JSON.parse(decryptSecret(payload)) as T;
}
