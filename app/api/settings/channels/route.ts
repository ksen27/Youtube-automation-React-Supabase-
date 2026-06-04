import { NextResponse } from "next/server";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";
import { resolveChannel } from "@/lib/youtube/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reference-channel management for the settings page.
//
// A reference channel is a row in channel_rules with rule='approved'. The
// subject-centric search pipeline searches these channels FIRST (scoped to
// each channelId, ordered by priority) before falling back to open YouTube.
//
//   GET    – list reference channels (approved rows) in search order.
//   POST   – add a channel by URL / @handle / id; resolves to a UC… id.
//   PATCH  – toggle `enabled` or set `priority` on an existing channel.
//   DELETE – remove a channel by id.

interface ChannelRow {
  id: string;
  channel_id: string | null;
  channel_title: string | null;
  enabled: boolean;
  priority: number;
}

function guardSupabase(): NextResponse | null {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }
  return null;
}

export async function GET() {
  const guard = guardSupabase();
  if (guard) return guard;
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("channel_rules")
    .select("id, channel_id, channel_title, enabled, priority")
    .eq("rule", "approved")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ channels: (data ?? []) as ChannelRow[] });
}

export async function POST(req: Request) {
  const guard = guardSupabase();
  if (guard) return guard;

  let body: { ref?: string; priority?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const ref = (body.ref ?? "").trim();
  if (!ref) return NextResponse.json({ error: "ref (channel URL, @handle, or id) is required" }, { status: 400 });

  // Resolve to a canonical UC… channelId + title via the YouTube API. We store
  // the resolved id, never the raw handle, because search.list's channelId
  // filter only accepts UC ids.
  let resolved: { channelId: string; channelTitle: string } | null;
  try {
    resolved = await resolveChannel(ref);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
  if (!resolved) {
    return NextResponse.json({ error: `could not resolve a channel from "${ref}"` }, { status: 404 });
  }

  const sb = getServerSupabase();
  // Reject duplicates: a channel already on the approved list shouldn't be
  // added twice (it would split its priority across two rows).
  const { data: existing } = await sb
    .from("channel_rules")
    .select("id")
    .eq("rule", "approved")
    .eq("channel_id", resolved.channelId)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ error: "channel already added", channelId: resolved.channelId }, { status: 409 });
  }

  const insert: Record<string, unknown> = {
    channel_id: resolved.channelId,
    channel_title: resolved.channelTitle,
    rule: "approved",
    enabled: true,
  };
  if (typeof body.priority === "number" && Number.isFinite(body.priority)) {
    insert.priority = Math.trunc(body.priority);
  }
  const { data, error } = await sb
    .from("channel_rules")
    .insert(insert)
    .select("id, channel_id, channel_title, enabled, priority")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ channel: data as ChannelRow }, { status: 201 });
}

export async function PATCH(req: Request) {
  const guard = guardSupabase();
  if (guard) return guard;

  let body: { id?: string; enabled?: boolean; priority?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.priority === "number" && Number.isFinite(body.priority)) {
    patch.priority = Math.trunc(body.priority);
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update (provide enabled and/or priority)" }, { status: 400 });
  }

  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("channel_rules")
    .update(patch)
    .eq("id", body.id)
    .eq("rule", "approved")
    .select("id, channel_id, channel_title, enabled, priority")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ channel: data as ChannelRow });
}

export async function DELETE(req: Request) {
  const guard = guardSupabase();
  if (guard) return guard;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param is required" }, { status: 400 });

  const sb = getServerSupabase();
  const { error } = await sb
    .from("channel_rules")
    .delete()
    .eq("id", id)
    .eq("rule", "approved");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
