// Shared-password access gate for CelebForge.
//
// The client requirement is simple: nobody outside the organization should be
// able to use the tool. We don't need per-user accounts for that — one shared
// password, checked at the edge by `proxy.ts`, locks the whole app (pages and
// API) behind a single login.
//
// Two independent secrets are at play here, and keeping them separate matters:
//
//   1. The SESSION SIGNING secret (AUTH_SECRET) — used only to HMAC-sign the
//      login cookie. This is read from env so the lightweight `proxy.ts` can
//      verify cookies on every request WITHOUT touching the database.
//
//   2. The ACCESS PASSWORD — what the client types to log in. This is now
//      stored (hashed) in the database so the client can CHANGE it at any time
//      from the settings page, with no redeploy. Until a password is set in the
//      DB, we fall back to the CELEBFORGE_PASSWORD env var so a fresh deploy is
//      never locked out. Password verification only runs in the Node-runtime
//      login API, so DB access there is fine.
//
// Everything cookie-related uses Web Crypto so it runs in any Next.js runtime.

const encoder = new TextEncoder();

export const SESSION_COOKIE = "cf_session";
// 30 days. The tool is an internal workhorse; re-typing the password monthly is
// a reasonable floor without being annoying.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// DB key under which the access-password hash is stored in app_settings.
const PASSWORD_SETTING_KEY = "access_password_hash";

// Session signing secret. Falls back to the service-role key (already a long
// random server-only string) if no dedicated AUTH_SECRET is set.
function getSessionSecret(): string {
  const secret = process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("Auth not configured. Set AUTH_SECRET (see .env.example).");
  }
  return secret;
}

// Auth is usable if we can sign cookies AND have *some* way to check a password
// — either a stored DB hash (checked at call time) or the bootstrap env var.
// The session-secret fallback means service-role-only deploys still work.
export function isAuthConfigured(): boolean {
  return Boolean(process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Constant-time string compare so we don't leak the password length/prefix via
// timing. Both inputs are hashed to a fixed width first, which also sidesteps
// the early-exit that `===` and naive loops have on length mismatch.
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  if (ha.length !== hb.length) return false;
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return new Uint8Array(digest);
}

// ---------------------------------------------------------------------------
// Password storage (DB-backed, changeable at runtime)
// ---------------------------------------------------------------------------
//
// We store a PBKDF2-SHA256 hash, never plaintext. Format is a self-describing
// string so the parameters travel with the hash and can be upgraded later:
//
//   pbkdf2$<iterations>$<saltHex>$<hashHex>
//
// PBKDF2 is available in Web Crypto on every Next.js runtime, so this works
// the same in dev, Node, and serverless.

const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2Hash(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

// Produce a storable hash string for a new password.
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2Hash(password, salt);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bufferToHex(salt)}$${bufferToHex(hash)}`;
}

// Check a candidate against a stored `pbkdf2$...` string. Returns false on any
// malformed input rather than throwing.
async function verifyAgainstStored(candidate: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  const salt = hexToBuffer(parts[2]);
  const expected = parts[3];
  if (!salt) return false;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(candidate),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return timingSafeEqualHex(bufferToHex(new Uint8Array(bits)), expected);
}

// Read the stored password hash from the DB, if any. Returns null when no
// password has been set in-app yet (the env bootstrap path then applies).
//
// `getStoredHash` is injected so this module never statically imports the
// Supabase server client — that keeps `lib/auth.ts` importable from the
// lightweight proxy (which only needs the cookie functions) without pulling the
// DB client into that bundle.
export async function verifyPassword(
  candidate: string,
  getStoredHash: () => Promise<string | null>,
): Promise<boolean> {
  let storedHash: string | null = null;
  try {
    storedHash = await getStoredHash();
  } catch {
    storedHash = null; // DB unreachable → fall through to env bootstrap
  }

  if (storedHash) {
    return verifyAgainstStored(candidate, storedHash);
  }

  // Bootstrap: no password set in-app yet. Accept the env password if present
  // so a fresh deploy can be logged into and then change the password.
  const envPassword = process.env.CELEBFORGE_PASSWORD;
  if (envPassword) return timingSafeEqual(candidate, envPassword);

  return false;
}

export { PASSWORD_SETTING_KEY };

async function hmac(message: string): Promise<string> {
  const secret = getSessionSecret();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bufferToHex(new Uint8Array(sig));
}

function bufferToHex(buf: Uint8Array): string {
  let out = "";
  for (const byte of buf) out += byte.toString(16).padStart(2, "0");
  return out;
}

function hexToBuffer(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

// Constant-time compare for two equal-purpose hex strings (already
// fixed-width hash digests), so password verification doesn't leak via timing.
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Mint a signed cookie value. Shape: `${expiryMs}.${hmac(expiryMs)}`.
export async function createSessionToken(): Promise<{ value: string; maxAgeSeconds: number }> {
  const expiry = nowMs() + SESSION_TTL_MS;
  const sig = await hmac(String(expiry));
  return { value: `${expiry}.${sig}`, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) };
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expiryStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < nowMs()) return false;
  const expected = await hmac(expiryStr);
  return timingSafeEqual(sig, expected);
}

// `Date.now()` isolated here so the rest of the module stays pure-ish and this
// is the single place to mock time in tests.
function nowMs(): number {
  return Date.now();
}
