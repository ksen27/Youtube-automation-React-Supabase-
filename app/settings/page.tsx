import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getEnv } from "@/lib/env";
import { isSupabaseConfigured, getServerSupabase } from "@/lib/supabase/server";
import { newRedisClient } from "@/lib/jobs/queue";
import { checkR2Health } from "@/lib/storage";

export const dynamic = "force-dynamic";

async function getStatus() {
  const env = getEnv();
  const youtube = Boolean(env.YOUTUBE_API_KEY);
  const gemini = Boolean(env.GEMINI_API_KEY);
  const supabase = isSupabaseConfigured();

  const storage = await checkR2Health();
  let redis = false;
  try {
    const c = newRedisClient();
    await c.ping();
    await c.quit();
    redis = true;
  } catch { redis = false; }

  let approved: Array<{ channel_id: string | null; channel_title: string | null }> = [];
  let blocked: Array<{ channel_id: string | null; channel_title: string | null }> = [];
  if (supabase) {
    try {
      const sb = getServerSupabase();
      const { data } = await sb.from("channel_rules").select("channel_id, channel_title, rule");
      for (const r of data ?? []) {
        if (r.rule === "approved") approved.push({ channel_id: r.channel_id, channel_title: r.channel_title });
        else if (r.rule === "blocked") blocked.push({ channel_id: r.channel_id, channel_title: r.channel_title });
      }
    } catch { /* ignore */ }
  }

  return { youtube, gemini, supabase, storage, redis, env, approved, blocked };
}

function StatusBadge({ ok }: { ok: boolean }) {
  return ok ? <Badge variant="success">configured</Badge> : <Badge variant="destructive">missing</Badge>;
}

export default async function SettingsPage() {
  const s = await getStatus();
  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Connection health for the services this MVP needs.</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>YouTube Data API</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex items-center justify-between"><span>YOUTUBE_API_KEY</span><StatusBadge ok={s.youtube} /></div>
            <p className="text-xs text-muted-foreground">Enable "YouTube Data API v3" in Google Cloud and set the key in <code>.env.local</code>.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Gemini</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex items-center justify-between"><span>GEMINI_API_KEY</span><StatusBadge ok={s.gemini} /></div>
            <p className="text-xs text-muted-foreground">Get a key at <a className="underline" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">aistudio.google.com</a>.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Supabase</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex items-center justify-between"><span>Database</span><StatusBadge ok={s.supabase} /></div>
            <p className="text-xs text-muted-foreground">Set <code>NEXT_PUBLIC_SUPABASE_URL</code>, <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>, and <code>SUPABASE_SERVICE_ROLE_KEY</code>.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Cloudflare R2</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex items-center justify-between"><span>Bucket "{s.env.R2_BUCKET}"</span><StatusBadge ok={s.storage} /></div>
            <p className="text-xs text-muted-foreground">Set <code>R2_ACCOUNT_ID</code>, <code>R2_ACCESS_KEY_ID</code>, <code>R2_SECRET_ACCESS_KEY</code>, <code>R2_BUCKET</code>, and <code>R2_PUBLIC_BASE_URL</code>. Bucket must be public via r2.dev or a custom domain.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Redis (BullMQ)</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex items-center justify-between"><span>Connection</span><StatusBadge ok={s.redis} /></div>
            <p className="text-xs text-muted-foreground">Run <code>docker compose up -d redis</code> or set <code>REDIS_URL</code>.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pipeline limits</CardTitle>
          <CardDescription>Hard caps from environment configuration.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm grid gap-2 sm:grid-cols-3">
          <div>Max videos / project: <strong>{s.env.MAX_VIDEOS_PER_PROJECT}</strong></div>
          <div>Max clips / video: <strong>{s.env.MAX_CLIPS_PER_VIDEO}</strong></div>
          <div>Max source duration: <strong>{s.env.MAX_SOURCE_DURATION_SECONDS}s</strong></div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Approved channels</CardTitle>
            <CardDescription>{s.approved.length} channels — bonus ranking</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            {s.approved.length === 0 ? (
              <p className="text-muted-foreground">No approved channels. Add rows in the <code>channel_rules</code> table with rule=approved.</p>
            ) : (
              <ul className="space-y-1">
                {s.approved.map((c, i) => (
                  <li key={i} className="flex justify-between"><span>{c.channel_title ?? "—"}</span><code className="text-xs text-muted-foreground">{c.channel_id ?? ""}</code></li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Blocked channels</CardTitle>
            <CardDescription>{s.blocked.length} channels — never selected</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            {s.blocked.length === 0 ? (
              <p className="text-muted-foreground">No blocked channels.</p>
            ) : (
              <ul className="space-y-1">
                {s.blocked.map((c, i) => (
                  <li key={i} className="flex justify-between"><span>{c.channel_title ?? "—"}</span><code className="text-xs text-muted-foreground">{c.channel_id ?? ""}</code></li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
