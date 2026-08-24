/**
 * End-to-end probe for the /thumbnails generator, through the REAL pipeline:
 * channel samples -> style prompt -> buildThumbnailPrompt -> persona face-lock
 * -> generateThumbnailFromReferences. Writes the image AND the exact prompts to
 * tmp/thumbnail-probe/, so a generation can be judged against what it was
 * actually told to draw (the usual question when one comes out wrong).
 *
 *   npx tsx --env-file=.env.local scripts/thumbnail-probe.ts <channel> "<title>" [saved] [rotation] [subjectUrl]
 *
 * channel    a thumbnail_channels UUID (uses its stored samples, no YouTube
 *            quota) or an @handle / channel URL resolved live.
 * saved      use the channel's STORED style_prompt — what production generates
 *            from today. Omit to RE-RUN analyzeChannelStyle, which is how a
 *            change to the analyzer prompt is seen before anyone re-analyzes.
 * rotation   which sample becomes the base image. Production derives this from
 *            how many thumbnails the channel already has; here it is explicit so
 *            one title can be forced onto different base poses — which is how a
 *            "they all look the same" complaint is told apart from a prompt bug.
 * subjectUrl an AI-avatar / person image (see thumbnail-avatar.ts). Takes the
 *            same path production does: the face becomes the ONLY image input,
 *            the channel style rides in the text alone, and a Pikzels persona
 *            locks the identity so the output cannot drift to another face.
 *
 * Writes no thumbnails or channel rows. Building a persona does cache a row in
 * thumbnail_personas — the one write this script makes, and a reusable one.
 * Costs one Pikzels generation per run, so keep the runs deliberate.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { getServerSupabase } from "@/lib/supabase/server";
import { fetchChannelThumbnails } from "@/lib/thumbnails/youtube";
import { analyzeChannelStyle, buildThumbnailPrompt } from "@/lib/thumbnails/gemini";
import { resolvePersonaForFace } from "@/lib/thumbnails/persona";
import {
  generateThumbnailFromReferences,
  pickStyleImage,
  buildChannelReferenceUrls,
  isPikzelsConfigured,
  pikzelsErrorMessage,
} from "@/lib/thumbnails/pikzels";

const OUT_DIR = path.join(process.cwd(), "tmp", "thumbnail-probe");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProbeChannel {
  title: string;
  urls: string[];
  savedStylePrompt: string | null;
}

async function loadChannel(ref: string): Promise<ProbeChannel> {
  if (!UUID_RE.test(ref)) {
    const ch = await fetchChannelThumbnails(ref);
    return { title: ch.channelTitle, urls: ch.thumbnailUrls, savedStylePrompt: null };
  }
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("thumbnail_channels")
    .select("channel_title, sample_urls, style_prompt")
    .eq("id", ref)
    .single();
  if (error || !data) throw new Error(`channel ${ref} not found: ${error?.message ?? "no row"}`);
  const urls = Array.isArray(data.sample_urls) ? (data.sample_urls as string[]) : [];
  if (urls.length === 0) throw new Error(`channel ${ref} has no stored samples`);
  return {
    title: data.channel_title as string,
    urls,
    savedStylePrompt: (data.style_prompt as string | null) ?? null,
  };
}

async function main(): Promise<void> {
  const channelRef = process.argv[2];
  const title = process.argv[3];
  const useSaved = (process.argv[4] ?? "").toLowerCase() === "saved";
  const rotation = Number(process.argv[5] ?? "0") || 0;
  const subjectUrl = (process.argv[6] ?? "").trim();
  const subjectUrls = subjectUrl ? [subjectUrl] : [];
  if (!channelRef || !title) {
    throw new Error(
      'usage: thumbnail-probe.ts <channel> "<video title>" [saved] [rotation] [subjectUrl]',
    );
  }
  if (!isPikzelsConfigured()) throw new Error("PIKZELS_API_KEY is not set");

  await fs.mkdir(OUT_DIR, { recursive: true });
  const slug =
    title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) +
    (useSaved ? "-saved" : "") +
    (rotation ? `-r${rotation}` : "") +
    (subjectUrls.length ? "-avatar" : "");

  const channel = await loadChannel(channelRef);
  console.log(`channel:  ${channel.title} — ${channel.urls.length} samples`);
  console.log(`title:    ${title}`);
  console.log(`style:    ${useSaved ? "SAVED style_prompt (what production uses today)" : "re-analyzed"}`);
  console.log(`rotation: ${rotation}`);
  console.log(`subject:  ${subjectUrls[0] ?? "(none — the channel's own face)"}`);
  console.log("");

  let stylePrompt: string;
  if (useSaved) {
    if (!channel.savedStylePrompt) throw new Error("channel has no saved style_prompt");
    stylePrompt = channel.savedStylePrompt;
  } else {
    stylePrompt = await analyzeChannelStyle(channel.urls);
    if (!stylePrompt) throw new Error("analyzeChannelStyle returned empty");
  }
  console.log(`--- STYLE PROMPT ---\n${stylePrompt}\n`);

  // Slot rule (buildChannelReferenceUrls): any uploaded face is the SOLE image
  // input, so styleImageSent is false there and the channel style has to be
  // carried by the text alone. With no subject, the channel's own thumbnail is
  // the base and IS the intended face.
  const styleImageUrl = pickStyleImage(channel.urls, rotation);
  const { referenceUrls, styleImageSent } = buildChannelReferenceUrls({ subjectUrls, styleImageUrl });

  const built = await buildThumbnailPrompt({
    stylePrompt,
    title,
    subjectCount: subjectUrls.length,
    styleImageSent,
  });
  const fbNote = built.usedFallback ? ` ${built.fallbackReason}` : "";
  console.log(`--- FINAL PROMPT (fallback=${built.usedFallback}${fbNote}) ---\n${built.prompt}\n`);
  console.log(`references: ${referenceUrls.join(", ")}`);

  // Identity lock, exactly as renderThumbnailRow does it: without a persona the
  // uploaded face is only a base image and the output drifts off it.
  let personaId: string | null = null;
  if (subjectUrls.length > 0) {
    personaId = await resolvePersonaForFace(getServerSupabase(), subjectUrls[0], title);
    console.log(`persona:    ${personaId ?? "(none — falling back to face-as-base)"}`);
  }
  console.log("");

  let outputUrl: string;
  try {
    const res = await generateThumbnailFromReferences({
      prompt: built.prompt,
      referenceUrls,
      personaId,
    });
    outputUrl = res.outputUrl;
  } catch (e) {
    throw new Error(pikzelsErrorMessage(e));
  }

  const dl = await fetch(outputUrl);
  if (!dl.ok) throw new Error(`download failed: ${dl.status}`);
  const img = Buffer.from(await dl.arrayBuffer());
  const imgFile = path.join(OUT_DIR, `${slug}.png`);
  await fs.writeFile(imgFile, img);
  await fs.writeFile(
    path.join(OUT_DIR, `${slug}.txt`),
    [
      `CHANNEL\n${channel.title}`,
      `TITLE\n${title}`,
      `STYLE PROMPT (${useSaved ? "saved" : "re-analyzed"})\n${stylePrompt}`,
      `FINAL PROMPT (fallback=${built.usedFallback})\n${built.prompt}`,
      `REFERENCES (rotation ${rotation}, persona ${personaId ?? "none"})\n${referenceUrls.join("\n")}`,
      `OUTPUT\n${outputUrl}`,
    ].join("\n\n") + "\n",
  );
  console.log(`saved: ${imgFile} (${Math.round(img.length / 1024)} KB)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
