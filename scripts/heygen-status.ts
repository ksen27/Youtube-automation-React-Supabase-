import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { getServerSupabase } from "@/lib/supabase/server";
import { getQueue, QUEUE_NAMES } from "@/lib/jobs/queue";

// Quick operational snapshot: HeyGen account pool + avatar queue depth.
//   npm run heygen:status
(async () => {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("heygen_accounts")
    .select("email,status,fail_count,cooldown_until,last_error_class,last_error,auth_saved_at")
    .order("created_at", { ascending: false });
  console.log("=== accounts ===");
  for (const a of data ?? []) console.log(JSON.stringify(a));

  const q = getQueue(QUEUE_NAMES.avatar);
  const counts = await q.getJobCounts("waiting", "active", "delayed", "failed", "completed");
  console.log("=== avatar queue ===");
  console.log(JSON.stringify(counts));
  await q.close();
  process.exit(0);
})();
