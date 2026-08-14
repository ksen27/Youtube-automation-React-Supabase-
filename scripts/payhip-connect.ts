import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { getContainer } from "@ebook/config";
import { interactivePayhipLogin } from "@ebook/infra";

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

async function main() {
  const c = getContainer();

  console.log("Connecting the Payhip session…");
  console.log("A browser window will open. Do NOT close it — log in by hand.\n");

  try {
    await interactivePayhipLogin(
      c.payhipSessions,
      {
        baseUrl: c.env.PAYHIP_BASE_URL,
        timeoutMs: c.env.PAYHIP_TIMEOUT_MS,
        debugDir: c.env.PAYHIP_DEBUG_DIR,
      },
      {
        maxWaitMs: 10 * 60_000, // give a human plenty of time
        onProgress: (m) => console.log(`  • ${m}`),
      },
    );
  } catch (err) {
    console.error(`\nConnect failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // The publisher caches "is a session stored?" — refresh it so a server started
  // before this ran stops reporting the feature as unconfigured.
  await c.checkoutPublisher.warmUp().catch(() => {});

  console.log("\n✓ Payhip session saved. Books can now be listed from the app.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
