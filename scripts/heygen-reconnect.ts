import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { getServerSupabase } from "@/lib/supabase/server";
import { getAccountByEmail, saveConnectedSession } from "@/lib/synthetic/heygen-accounts";
import { interactiveConnect } from "@/lib/synthetic/heygen-auth";

// Reconnect a HeyGen account WITHOUT having to remember its email.
//
//   npm run heygen:reconnect            # auto-pick the account needing re-auth
//   npm run heygen:reconnect <email>    # reconnect a specific account
//
// Same headed login flow as heygen:connect, but when no email is given it finds
// the account flagged needs_reauth and reconnects that one — the common case
// when the pool emptied mid-batch. If several need re-auth it lists them and
// asks you to name one. Run on a machine WITH a display; the session is saved to
// the shared DB and the headless worker reuses it.

async function pickEmail(explicit?: string): Promise<string> {
  if (explicit) return explicit.trim().toLowerCase();
  const sb = getServerSupabase();
  const { data } = await sb
    .from("heygen_accounts")
    .select("email,status")
    .eq("status", "needs_reauth")
    .order("last_used_at", { ascending: true, nullsFirst: true });
  const candidates = (data ?? []) as Array<{ email: string }>;
  if (candidates.length === 0) {
    console.error(
      "No account is flagged needs_reauth. Nothing to reconnect.\n" +
        "Pass an email explicitly to force a reconnect: npm run heygen:reconnect <email>",
    );
    process.exit(1);
  }
  if (candidates.length > 1) {
    console.error(
      "Multiple accounts need re-auth — name the one to reconnect:\n" +
        candidates.map((c) => `  npm run heygen:reconnect ${c.email}`).join("\n"),
    );
    process.exit(2);
  }
  return candidates[0].email;
}

async function main() {
  const email = await pickEmail(process.argv[2]);
  const account = await getAccountByEmail(email);
  if (!account) {
    console.error(`No HeyGen account with email "${email}" in the pool.`);
    process.exit(1);
  }

  console.log(`Reconnecting HeyGen session for ${email}…`);
  console.log("A browser window will open. Do NOT close it — log in by hand.\n");

  let state: unknown;
  try {
    state = await interactiveConnect(account, {
      maxWaitMs: 10 * 60_000,
      onProgress: (m) => console.log(`  • ${m}`),
    });
  } catch (err) {
    console.error(`\nReconnect failed: ${(err as Error).message}`);
    process.exit(1);
  }

  await saveConnectedSession(account.id, state);
  console.log(`\n✓ Session saved for ${email}. The account is active and back in rotation.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
