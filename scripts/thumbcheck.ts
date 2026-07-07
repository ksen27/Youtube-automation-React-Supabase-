import { getServerSupabase } from "../lib/supabase/server";

async function main() {
  const db = getServerSupabase();
  const { data: channels } = await db
    .from("thumbnail_channels")
    .select("id,channel_input,channel_title,style_prompt,sample_urls,updated_at")
    .order("updated_at", { ascending: false })
    .limit(10);
  for (const c of channels ?? []) {
    console.log(`\n=== ${c.channel_title} | input=${c.channel_input} (${c.id.slice(0, 8)}) ===`);
    console.log("STYLE PROMPT:");
    console.log(c.style_prompt);
    console.log("samples:", (c.sample_urls as string[])?.length ?? 0);
  }
  const { data: thumbs } = await db
    .from("thumbnails")
    .select("id,title,prompt,status,created_at,channel_id")
    .order("created_at", { ascending: false })
    .limit(5);
  console.log("\n\n########## RECENT GENERATED THUMBNAILS ##########");
  for (const t of thumbs ?? []) {
    console.log(`\n--- "${t.title}" [${t.status}] (${t.id.slice(0, 8)}) ---`);
    console.log(t.prompt);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
