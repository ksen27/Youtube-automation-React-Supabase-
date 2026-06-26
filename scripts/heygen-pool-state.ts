import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { getServerSupabase } from "@/lib/supabase/server";

// Reactivate any account that was flagged needs_reauth BUT still holds valid
// cookies (the false-expiry case). Pass `--print` to only list state.
async function main() {
  const sb = getServerSupabase();
  if (process.argv.includes("--reactivate")) {
    const { data, error } = await sb
      .from("heygen_accounts")
      .update({
        status: "active",
        fail_count: 0,
        cooldown_until: null,
        last_error_class: null,
        last_error: null,
      })
      .eq("status", "needs_reauth")
      .select("email");
    if (error) {
      console.error(error);
      process.exit(1);
    }
    console.log("reactivated:", (data ?? []).map((r) => r.email).join(", ") || "(none)");
  }
  const { data } = await sb
    .from("heygen_accounts")
    .select("email, status, fail_count, last_used_at, last_error_class, auth_saved_at")
    .order("created_at", { ascending: true });
  for (const r of data ?? []) {
    console.log(`${r.email} | status=${r.status} | fail=${r.fail_count} | auth_saved=${r.auth_saved_at} | err_class=${r.last_error_class}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
