// Shared-password access gate for CelebForge.
//
// The client requirement is simple: nobody outside the organization should be
// able to use the tool. We don't need per-user accounts for that — one shared
// password, checked at the edge by `proxy.ts`, locks the whole app (pages and
// API) behind a single login.
//
// How the session works: when the right password is submitted we mint an
// HMAC-signed cookie value `${expiry}.${signature}`. Every request re-verifies
// the signature and expiry. The cookie carries no secret and can't be forged
// without AUTH_SECRET, so a leaked cookie is the only exposure — hence the
// expiry. Everything here uses Web Crypto so it runs in any Next.js runtime.

const encoder = new TextEncoder();

export const SESSION_COOKIE = "cf_session";
// 30 days. The tool is an internal workhorse; re-typing the password monthly is
// a reasonable floor without being annoying.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function getAuthConfig(): { password: string; secret: string } {
  const password = process.env.CELEBFORGE_PASSWORD;
  // Fall back to the service-role key as signing material if no dedicated
  // secret is set — it's already a long random server-only string. A dedicated
  // AUTH_SECRET is preferred (see .env.example) so rotating it doesn't touch
  // the database client.
  const secret = process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!password || !secret) {
    throw new Error(
      "Auth not configured. Set CELEBFORGE_PASSWORD and AUTH_SECRET (see .env.example).",
    );
  }
  return { password, secret };
}

export function isAuthConfigured(): boolean {
  return Boolean(
    process.env.CELEBFORGE_PASSWORD &&
      (process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY),
  );
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

export async function verifyPassword(candidate: string): Promise<boolean> {
  const { password } = getAuthConfig();
  return timingSafeEqual(candidate, password);
}

async function hmac(message: string): Promise<string> {
  const { secret } = getAuthConfig();
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
