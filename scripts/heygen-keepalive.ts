import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { markNeedsReauth, getRefreshableAccounts } from "@/lib/synthetic/heygen-accounts";
import { keepAliveSession } from "@/lib/synthetic/heygen-auth";

// Keep HeyGen sessions warm so a single account stays logged in far longer.
//
//   npm run heygen:keepalive            # one-shot: ping once, exit
//   npm run heygen:keepalive -- --watch # loop: ping every interval until Ctrl-C
//
// WHY: workers never log in (login needs a human). HeyGen invalidates an idle
// session on a sliding-window TTL, so after a burst (or a quiet period) the
// account drops to needs_reauth and the avatar pool empties. This script opens
// each active account's stored session, verifies it, and re-saves fresh cookies
// — resetting that window WITHOUT running a job. Run it on a machine WITH a
// display; the refreshed session lands in the shared DB, so the headless Fly
// worker reuses it. An account whose session has genuinely expired is flagged
// needs_reauth (reconnect it with `npm run heygen:reconnect`).
//
// Default interval is 30 min (override with HEYGEN_KEEPALIVE_MINUTES). Pick a
// value below HeyGen's idle-session TTL so the window never lapses.

const WATCH = process.argv.includes("--watch");
const INTERVAL_MIN = Number(process.env.HEYGEN_KEEPALIVE_MINUTES) || 30;

async function pingOnce(): Promise<void> {
  // Active OR cooldown accounts hold a live session worth refreshing (shared
  // helper — same set the server-side sweep uses).
  const accounts = await getRefreshableAccounts();
  if (accounts.length === 0) {
    console.log(`[${new Date().toISOString()}] no active accounts to keep alive`);
    return;
  }
  for (const acc of accounts) {
    try {
      const verdict = await keepAliveSession(acc);
      if (verdict === "authed") {
        console.log(`[${new Date().toISOString()}] ✓ ${acc.email} — session refreshed`);
      } else {
        // Session is gone; take it out of rotation so the worker doesn't burn an
        // avatar attempt on a dead session, and the operator knows to reconnect.
        await markNeedsReauth(acc.id, "keepalive: session expired");
        console.log(
          `[${new Date().toISOString()}] ✗ ${acc.email} — EXPIRED, flagged needs_reauth ` +
            `(run: npm run heygen:reconnect)`,
        );
      }
    } catch (err) {
      // A transient keep-alive error (proxy blip, slow SPA) must NOT flag the
      // account — only a confirmed "expired" verdict does. Just log and move on.
      console.warn(
        `[${new Date().toISOString()}] ! ${acc.email} — keepalive error (left as-is): ` +
          `${(err as Error).message?.slice(0, 160)}`,
      );
    }
  }
}

async function main() {
  if (!WATCH) {
    await pingOnce();
    process.exit(0);
  }
  console.log(
    `HeyGen keep-alive watching every ${INTERVAL_MIN} min. Press Ctrl-C to stop.\n` +
      `Leave this running on your PC during a work session to keep the account logged in.`,
  );
  // Loop forever: ping, then sleep. A thrown error in pingOnce is already
  // swallowed per-account, so the loop itself is resilient.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pingOnce().catch((e) => console.error("keepalive cycle error:", (e as Error).message));
    await new Promise((r) => setTimeout(r, INTERVAL_MIN * 60_000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
