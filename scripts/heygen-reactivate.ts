import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { getServerSupabase } from "@/lib/supabase/server";

// Operational helper: bring a connected HeyGen account back into rotation.
//
//   npm run heygen:reactivate            -> reactivate ALL accounts with a session
//   npm run heygen:reactivate <email>    -> reactivate just one
//
// Clears cooldown / needs_reauth / disabled and resets the failure counters,
// but ONLY for accounts that already have a stored session (cookies_json) — a
// session-less account would just fail verification again, so it stays out
// until `npm run heygen:connect <email>` gives it one.
(async () => {
  const email = process.argv[2]?.trim().toLowerCase();
  const sb = getServerSupabase();
  const q = sb
    .from("heygen_accounts")
    .update({ status: "active", fail_count: 0, cooldown_until: null, last_error: null, last_error_class: null })
    .not("cookies_json", "is", null);
  const { data, error } = await (email ? q.eq("email", email) : q).select("email,status");
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log("Reactivated:", data);
  process.exit(0);
})();
