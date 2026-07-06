import { createClient } from "@supabase/supabase-js";
(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.log("MISSING_ENV", { url: !!url, key: !!key }); return; }
  const sb = createClient(url, key);
  for (const [table, cols] of [
    ["thumbnails", "id, channel_id, title, prompt, subject_urls, reference_urls, output_url, status, error, created_at"],
    ["thumbnail_channels", "id, channel_input, channel_id, channel_title, style_prompt, sample_urls, created_at"],
  ] as const) {
    const { error } = await sb.from(table).select(cols).limit(1);
    console.log(table, "->", error ? `ERROR: ${error.message}` : "OK (all columns present)");
  }
  const { error: upErr } = await sb.from("thumbnail_channels").upsert(
    { channel_input: "__probe__", channel_id: "__probe__", channel_title: "", style_prompt: "", sample_urls: [] },
    { onConflict: "channel_id" }
  ).select("id").maybeSingle();
  console.log("upsert onConflict=channel_id ->", upErr ? `ERROR: ${upErr.message}` : "OK");
  await sb.from("thumbnail_channels").delete().eq("channel_id", "__probe__");
})();
