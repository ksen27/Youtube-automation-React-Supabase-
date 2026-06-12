import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { isSupabaseConfigured, getServerSupabase } from "@/lib/supabase/server";
import { ReferenceChannels, type ReferenceChannel } from "./reference-channels";
import { ChangePassword } from "./change-password";
import { hasCustomPassword } from "@/lib/auth-store";

export const dynamic = "force-dynamic";

async function getStatus() {
  const supabase = isSupabaseConfigured();

  let referenceChannels: ReferenceChannel[] = [];
  let blocked: Array<{ channel_id: string | null; channel_title: string | null }> = [];
  if (supabase) {
    try {
      const sb = getServerSupabase();
      const { data } = await sb
        .from("channel_rules")
        .select("id, channel_id, channel_title, rule, enabled, priority")
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true });
      for (const r of data ?? []) {
        if (r.rule === "approved") {
          referenceChannels.push({
            id: r.id,
            channel_id: r.channel_id,
            channel_title: r.channel_title,
            enabled: r.enabled ?? true,
            priority: r.priority ?? 100,
          });
        } else if (r.rule === "blocked") {
          blocked.push({ channel_id: r.channel_id, channel_title: r.channel_title });
        }
      }
    } catch { /* ignore */ }
  }

  let customPassword = false;
  try {
    customPassword = await hasCustomPassword();
  } catch { /* default password still in use */ }

  return { referenceChannels, blocked, customPassword };
}

export default async function SettingsPage() {
  const s = await getStatus();
  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Account and channel preferences.</p>
      </header>

      <ChangePassword hasCustomPassword={s.customPassword} />

      <ReferenceChannels initial={s.referenceChannels} />

      <div className="grid gap-4 sm:grid-cols-2">
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
