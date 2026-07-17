import Link from "next/link";
import { Image as ImageIcon } from "lucide-react";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";
import { isPikzelsConfigured } from "@/lib/thumbnails/pikzels";
import { getEnv } from "@/lib/env";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { NewThumbnailForm, type ChannelRow } from "./new-thumbnail-form";
import { BatchThumbnailForm } from "./batch-thumbnail-form";
import { ThumbnailCard, type ThumbnailRow } from "./thumbnail-card";

export const dynamic = "force-dynamic";

// Thumbnails — a third top-level product (separate from Celebrity Videos and
// AI Avatar). A two-step tool: (1) analyze a YouTube channel so Gemini learns
// its thumbnail style, then (2) generate a new thumbnail in that style from a
// title + optional subject image(s), rendered via Pikzels.

async function loadThumbnails(): Promise<ThumbnailRow[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("thumbnails")
    .select("id, title, prompt, reference_urls, output_url, status, error, created_at")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) return [];
  return (data ?? []) as ThumbnailRow[];
}

async function loadChannels(): Promise<ChannelRow[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("thumbnail_channels")
    .select("id, channel_input, channel_id, channel_title, style_prompt, sample_urls, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return [];
  return (data ?? []) as ChannelRow[];
}

export default async function ThumbnailsPage() {
  const [thumbnails, channels] = await Promise.all([loadThumbnails(), loadChannels()]);
  const env = getEnv();
  const ready =
    isPikzelsConfigured() &&
    Boolean(env.GEMINI_API_KEY) &&
    Boolean(env.YOUTUBE_API_KEY_THUMBNAILS || env.YOUTUBE_API_KEY);

  return (
    <div className="px-6 lg:px-8 py-8 max-w-7xl mx-auto space-y-10">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-[18px] border border-border bg-bg-elevated p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-0"
          style={{
            background:
              "radial-gradient(600px 220px at 80% 0%, rgba(244,114,182,0.18), transparent 60%), radial-gradient(500px 200px at 0% 100%, rgba(168,85,247,0.18), transparent 60%)",
          }}
        />
        <div className="relative max-w-2xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-pink-500/10 border border-pink-500/30 px-2.5 h-6 text-[11px] font-medium text-pink-300">
            <ImageIcon className="h-3 w-3" /> Thumbnails
          </span>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-fg">
            Generate thumbnails in your <span className="gradient-text">channel&apos;s style</span>.
          </h1>
          <p className="mt-2 text-sm text-fg-muted">
            Paste a YouTube channel and we learn its thumbnail style. Then add a title (and optionally a celebrity or AI-avatar image) and we generate a matching thumbnail via Pikzels.
          </p>
        </div>
      </section>

      {/* New thumbnail */}
      <Card>
        <CardHeader>
          <CardTitle>New thumbnail</CardTitle>
          <CardDescription>
            Learn a channel&apos;s style, then generate a thumbnail from a title and optional subject image(s).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ready ? (
            <NewThumbnailForm channels={channels} />
          ) : (
            <p className="text-sm text-fg-muted">
              Thumbnail generation is not configured. Set <code>PIKZELS_API_KEY</code>, <code>GEMINI_API_KEY</code>,
              and <code>YOUTUBE_API_KEY_THUMBNAILS</code> (or <code>YOUTUBE_API_KEY</code>) in <code>.env.local</code>. See{" "}
              <Link className="underline text-brand-300" href="/settings">settings</Link>.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Batch — generate several independent thumbnails at once (fire-and-poll) */}
      {ready && channels.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Generate several at once</CardTitle>
            <CardDescription>
              Queue up to 4 independent thumbnails — each with its own channel, title, and prompt. They
              render in the background and appear in the gallery as they finish.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BatchThumbnailForm channels={channels} />
          </CardContent>
        </Card>
      )}

      {/* Gallery */}
      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-fg-muted">Recent thumbnails</h2>
          <span className="text-xs text-fg-subtle tabular-nums">{thumbnails.length} total</span>
        </div>
        {thumbnails.length === 0 ? (
          <EmptyState
            icon={<ImageIcon className="h-5 w-5" />}
            title="No thumbnails yet"
            description="Add reference thumbnails and a title above to generate your first one."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {thumbnails.map((t) => (
              <ThumbnailCard key={t.id} thumbnail={t} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
