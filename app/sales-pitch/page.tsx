import { Megaphone } from "lucide-react";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { NewPitchForm } from "./new-pitch-form";
import { PitchCard, type PitchVideoRow } from "./pitch-card";

export const dynamic = "force-dynamic";

// Sales Pitch — a standalone top-level product (its own sidebar tool), separate
// from AI Avatar so the two aren't confused (client 2026-07-21). It generates a
// sales-pitch video — an avatar talking-head (from a photo + script, narrated by
// a 69labs voice) followed by a screen-recording that scrolls the real website —
// which the user downloads and then uploads to an AI Avatar project via that
// project's existing sales-pitch upload field.

async function loadPitchVideos(): Promise<PitchVideoRow[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("pitch_videos")
    .select("id, title, website_url, output_url, duration_seconds, status, error, created_at")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) return [];
  return (data ?? []) as PitchVideoRow[];
}

export default async function SalesPitchPage() {
  const pitchVideos = await loadPitchVideos();

  return (
    <div className="px-6 lg:px-8 py-8 max-w-7xl mx-auto space-y-10">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-[18px] border border-border bg-bg-elevated p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-0"
          style={{
            background:
              "radial-gradient(600px 220px at 80% 0%, rgba(56,189,248,0.18), transparent 60%), radial-gradient(500px 200px at 0% 100%, rgba(168,85,247,0.18), transparent 60%)",
          }}
        />
        <div className="relative max-w-2xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 border border-sky-500/30 px-2.5 h-6 text-[11px] font-medium text-sky-300">
            <Megaphone className="h-3 w-3" /> Sales Pitch
          </span>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-fg">
            Generate a <span className="gradient-text">sales pitch video</span>.
          </h1>
          <p className="mt-2 text-sm text-fg-muted">
            An AI avatar presents your script, then the video scrolls through your real website. Download the
            result and upload it to any AI Avatar project&apos;s sales-pitch field.
          </p>
        </div>
      </section>

      {/* New pitch */}
      <Card>
        <CardHeader>
          <CardTitle>New sales pitch</CardTitle>
          <CardDescription>
            Enter a website, an avatar photo, and the script. We generate the pitch in the background — it appears
            below when ready.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NewPitchForm />
        </CardContent>
      </Card>

      {/* Gallery */}
      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-fg-muted">Recent pitches</h2>
          <span className="text-xs text-fg-subtle tabular-nums">{pitchVideos.length} total</span>
        </div>
        {pitchVideos.length === 0 ? (
          <EmptyState
            icon={<Megaphone className="h-5 w-5" />}
            title="No pitches yet"
            description="Fill in a website, avatar photo, and script above to generate your first pitch video."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {pitchVideos.map((pv) => (
              <PitchCard key={pv.id} pitch={pv} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
