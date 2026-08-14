import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { SupabaseClientFactory, PayhipSessionStore, interactivePayhipLogin } from "@ebook/infra";

// One-time (or re-)connect of the Payhip browser session.
//
//   npm run payhip:connect
//
// Payhip has no API for creating products, so listing a finished book drives
// their real dashboard in a headless browser. That browser has to arrive
// already logged in — and the worker must never log in itself: a headless login
// walks straight into 2FA/captcha, and giving a worker credentials means
// storing credentials on a worker.
//
// So a human runs THIS script on a machine WITH a display: a visible browser
// opens, you log in to Payhip by hand (handling any captcha / email code / 2FA),
// and on success the encrypted Playwright session is written to the database.
// Every headless worker then reuses it. Re-run this whenever the app reports the
// session has expired.
//
// The session is a bearer credential — anyone holding it is logged into the
// store — which is why it is encrypted at rest and never written to a file.
//
// DELIBERATELY DOES NOT BUILD THE DI CONTAINER. Logging into a store has nothing
// to do with Anthropic, YouTube, Redis or the export pipeline, and `loadEnv()`
// demands all of their keys before it will return. Requiring an ANTHROPIC_API_KEY
// to type a password into a browser is not a real dependency, and it blocks the
// one command an operator runs when they are trying to get set up in the first
// place. Only the two things this actually needs are read here.

/** The Payhip settings, with the same defaults the app's env schema applies. */
function payhipConfig() {
  return {
    baseUrl: process.env.PAYHIP_BASE_URL || "https://payhip.com",
    timeoutMs: Number(process.env.PAYHIP_TIMEOUT_MS ?? 45_000),
    debugDir: process.env.PAYHIP_DEBUG_DIR || "/tmp/payhip-debug",
  };
}

/**
 * Supabase, read directly rather than through `loadEnv()`.
 *
 * The URL fallback mirrors the app's: this project names it
 * NEXT_PUBLIC_SUPABASE_URL, and upstream called it SUPABASE_URL.
 */
function supabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [
    !url && "NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)",
    !key && "SUPABASE_SERVICE_ROLE_KEY",
    !process.env.SECRET_BOX_KEY && "SECRET_BOX_KEY (generate with: openssl rand -hex 32)",
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(
      `Missing environment in .env.local:\n${missing.map((m) => `  - ${m}`).join("\n")}\n\n` +
        "These three are all this command needs: where to store the session, and the key to encrypt it with.",
    );
    process.exit(2);
  }
  return SupabaseClientFactory.serviceRole(url as string, key as string);
}

async function main() {
  const sessions = new PayhipSessionStore(supabase());

  console.log("Connecting the Payhip session…");
  console.log("A browser window will open. Do NOT close it — log in by hand.\n");

  try {
    await interactivePayhipLogin(sessions, payhipConfig(), {
      maxWaitMs: 10 * 60_000, // give a human plenty of time
      onProgress: (m) => console.log(`  • ${m}`),
    });
  } catch (err) {
    console.error(`\nConnect failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // Nothing to warm here — the publisher's `isConfigured()` cache lives in the
  // SERVER process, not this one. The card's GET re-reads it on every load, so
  // a running dev server picks this up on the next refresh without a restart.
  console.log("\n✓ Payhip session saved. Reload the book's page in the app — no restart needed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
