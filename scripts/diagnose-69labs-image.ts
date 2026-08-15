// Diagnostic probe for 69labs image generation.
//
// Answers ONE question: why is the 69labs image path failing right now? It
// submits a real generation to /api/v1/images/generate for EACH configured key
// and prints the raw HTTP status + body, with NO retry, NO key failover, and NO
// Gemini/fal.ai fallback — so nothing masks the real provider response the way
// generateImage() deliberately does in production.
//
// Run with the 69labs key(s) available in the environment, e.g.:
//   npx tsx --env-file=.env.local scripts/diagnose-69labs-image.ts
//
// Optional: pass a custom prompt as the first arg.
//
// COSTS: a successful submit spends one generation's credit per configured key.
// It does NOT poll or download — the job is left to finish server-side.
import { getEnv } from "@/lib/env";

// How to read each outcome. This is the whole point of the script: 69labs
// overloads a handful of status codes, and the body text is what separates a
// dead key from a busy account from a provider outage.
const VERDICTS: Array<{ match: (status: number, body: string) => boolean; verdict: string }> = [
  {
    match: (s, b) => s === 403 && /concurrent.*limit reached/i.test(b),
    verdict:
      "TRANSIENT — account is at its concurrent-generation ceiling. Key is fine. " +
      "Zombie generations from earlier timed-out jobs may be holding slots; they clear on their own. " +
      "Check SIXTYNINE_ACCOUNT_CONCURRENCY vs your real tier limit.",
  },
  {
    match: (s) => s === 403 || s === 401,
    verdict:
      "PERMANENT — key is rejected (revoked, expired, blocked, or wrong account). " +
      "This is the one case where the key really is the problem.",
  },
  {
    match: (s) => s === 402,
    verdict: "PERMANENT — payment/credit required. Top up the 69labs account.",
  },
  {
    match: (s) => s === 429,
    verdict: "TRANSIENT — request-rate limited. Back off and retry.",
  },
  {
    match: (s) => s >= 500,
    verdict:
      "PROVIDER-SIDE — 69labs is failing/cooling down. Key is fine. If it persists across " +
      "several minutes it is an outage on their end, not a config problem here.",
  },
];

function verdictFor(status: number, body: string): string {
  return VERDICTS.find((v) => v.match(status, body))?.verdict ?? "Unrecognised response.";
}

// Mirror keyPool() in lib/synthetic/sixtynine-labs.ts, which is module-private.
function keys(): Array<{ label: string; key: string }> {
  const env = getEnv();
  const extra = (env.SIXTYNINE_LABS_API_KEYS || "").split(/[\n,]/).map((k) => k.trim());
  const candidates: Array<[string, string | undefined]> = [
    ["SIXTYNINE_LABS_API_KEY", env.SIXTYNINE_LABS_API_KEY],
    ["SIXTYNINE_LABS_API_KEY_BACKUP", env.SIXTYNINE_LABS_API_KEY_BACKUP],
    ["SIXTYNINE_LABS_API_KEY_3", env.SIXTYNINE_LABS_API_KEY_3],
    ...extra.map((k, i) => [`SIXTYNINE_LABS_API_KEYS[${i}]`, k] as [string, string]),
  ];
  const seen = new Set<string>();
  const pool: Array<{ label: string; key: string }> = [];
  for (const [label, raw] of candidates) {
    const key = (raw || "").trim();
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      pool.push({ label, key });
    }
  }
  return pool;
}

async function main() {
  const env = getEnv();
  const base = env.SIXTYNINE_LABS_BASE_URL.replace(/\/$/, "");
  const pool = keys();

  console.log("=== 69labs image diagnostic ===");
  console.log("  base URL   :", base);
  console.log("  model      :", env.SIXTYNINE_LABS_IMAGE_MODEL);
  console.log("  resolution :", env.SIXTYNINE_LABS_IMAGE_RESOLUTION || "(provider default)");
  console.log("  keys found :", pool.length);
  console.log("  account id :", env.SIXTYNINE_ACCOUNT_ID || "(unset — derived from key prefix)");
  console.log("  cap/account:", env.SIXTYNINE_ACCOUNT_CONCURRENCY);
  console.log();

  if (pool.length === 0) {
    console.error("No 69labs keys configured. Set SIXTYNINE_LABS_API_KEY.");
    process.exit(1);
  }

  const prompt =
    process.argv[2] ||
    "A candid amateur smartphone photo of a kitchen table with morning light, slightly grainy.";

  let anyOk = false;
  for (const { label, key } of pool) {
    // Never print the secret — the prefix is enough to tell two keys apart.
    console.log(`--- ${label} (${key.slice(0, 8)}…) ---`);
    const t0 = Date.now();
    try {
      const res = await fetch(`${base}/api/v1/images/generate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          model: env.SIXTYNINE_LABS_IMAGE_MODEL,
          aspectRatio: "16:9",
          ...(env.SIXTYNINE_LABS_IMAGE_RESOLUTION
            ? { resolution: env.SIXTYNINE_LABS_IMAGE_RESOLUTION }
            : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.text();
      const ms = Date.now() - t0;
      console.log(`  HTTP ${res.status} ${res.statusText} (${ms}ms)`);
      console.log(`  body: ${body.slice(0, 400)}`);
      if (res.ok) {
        anyOk = true;
        console.log("  VERDICT: OK — submit accepted, this key can generate.");
      } else {
        console.log(`  VERDICT: ${verdictFor(res.status, body)}`);
      }
    } catch (e) {
      console.log(`  NETWORK FAILURE after ${Date.now() - t0}ms: ${(e as Error).message}`);
      console.log("  VERDICT: could not reach 69labs at all — DNS/egress/firewall, or they are down.");
    }
    console.log();
  }

  console.log(
    anyOk
      ? "At least one key submits successfully — the 69labs path itself is healthy."
      : "No key could submit. The verdict above is the reason images fall back to Gemini/fal.ai.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
