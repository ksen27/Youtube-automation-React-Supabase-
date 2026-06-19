import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import {
  getAccountByEmail,
  saveConnectedSession,
} from "@/lib/synthetic/heygen-accounts";
import { interactiveConnect } from "@/lib/synthetic/heygen-auth";

// One-time (or re-)connect of a HeyGen account's browser session.
//
//   npm run heygen:connect <email>
//
// Workers NEVER log in. Instead a human runs THIS script on a machine WITH a
// display: it opens a visible browser, you log in to HeyGen by hand (handling
// any captcha / email-code / SSO), and on success the encrypted Playwright
// storageState is written to the DB. Every headless worker then reuses that
// session. When an account is flagged `needs_reauth`, re-run this for it.
//
// The account must already exist in the pool (add it in Settings → HeyGen
// accounts, or via the API). This script only attaches a session to it.

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("Usage: npm run heygen:connect <email>");
    process.exit(2);
  }

  const account = await getAccountByEmail(email);
  if (!account) {
    console.error(
      `No HeyGen account with email "${email}" in the pool.\n` +
        "Add it first in Settings → HeyGen accounts (email + password), then re-run this.",
    );
    process.exit(1);
  }

  console.log(`Connecting HeyGen session for ${email}…`);
  console.log("A browser window will open. Do NOT close it — log in by hand.\n");

  let state: unknown;
  try {
    state = await interactiveConnect(account, {
      maxWaitMs: 10 * 60_000, // give a human plenty of time
      onProgress: (m) => console.log(`  • ${m}`),
    });
  } catch (err) {
    console.error(`\nConnect failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // Persist as a fully-connected session: clears needs_reauth/cooldown/disabled,
  // resets counters, stamps auth_saved_at — back in rotation immediately.
  await saveConnectedSession(account.id, state);

  console.log(`\n✓ Session saved for ${email}. The account is active and back in rotation.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
