import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TimelineItemPatch = z.object({
  id: z.string().uuid(),
  position: z.number().int().min(0).optional(),
  clip_id: z.string().uuid().nullable().optional(),
  duration: z.number().positive().max(60).optional(),
  script_text: z.string().max(8000).nullable().optional(),
  overlay_text: z.string().max(500).nullable().optional(),
  type: z.enum(["intro", "footage", "image", "title_card", "split_2", "split_4", "lower_third", "transition"]).optional(),
  approved: z.boolean().optional(),
  // Updatable so the block-editor swap modal can drop in an image from the
  // project's existing image pool, including a cross-type swap (footage→image).
  image_url: z.string().url().nullable().optional(),
  delete: z.boolean().optional(),
});

const PatchBody = z.object({
  items: z.array(TimelineItemPatch).max(500),
  approve_all: z.boolean().optional(),
});

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("timeline_items")
    .select("*")
    .eq("project_id", id)
    .order("position", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data ?? [] });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }

  const sb = getServerSupabase();
  for (const it of parsed.data.items) {
    if (it.delete) {
      const { error } = await sb.from("timeline_items").delete().eq("id", it.id).eq("project_id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (it.position !== undefined)     patch.position = it.position;
    if (it.clip_id !== undefined)      patch.clip_id = it.clip_id;
    if (it.duration !== undefined)     patch.duration = it.duration;
    if (it.script_text !== undefined)  patch.script_text = it.script_text;
    if (it.overlay_text !== undefined) patch.overlay_text = it.overlay_text;
    if (it.type !== undefined)         patch.type = it.type;
    if (it.approved !== undefined)     patch.approved = it.approved;
    if (it.image_url !== undefined)    patch.image_url = it.image_url;
    if (Object.keys(patch).length === 0) continue;
    const { error } = await sb.from("timeline_items").update(patch).eq("id", it.id).eq("project_id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (parsed.data.approve_all) {
    const { error } = await sb.from("timeline_items").update({ approved: true }).eq("project_id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: items } = await sb
    .from("timeline_items")
    .select("*")
    .eq("project_id", id)
    .order("position", { ascending: true });

  return NextResponse.json({ items: items ?? [] });
}
