/* eslint-disable no-console */
// One-off repair for avatar segments persisted with a degenerate spoken window
// (end_time - start_time <= 0.2s, or null times) — the "empty spoken window
// (no audio to lip-sync)" fast-fail. Re-planning would regenerate every image/
// clip (credit waste); this instead applies the planner's zero-window absorb
// directly to the stored rows: delete the doomed avatar block and, if that
// leaves a real gap in the timeline, extend an adjacent image/ai_clip block's
// window to cover it (those re-render from the existing still at final render —
// no provider credits). Avatar/split_2 neighbors are never extended (that would
// invalidate an already-rendered HeyGen clip).
//
//   npx tsx --env-file=.env.local scripts/fix-zero-window-avatar.ts             # scan (dry-run, all projects)
//   npx tsx --env-file=.env.local scripts/fix-zero-window-avatar.ts --apply     # fix all found
//   npx tsx --env-file=.env.local scripts/fix-zero-window-avatar.ts --apply --project <id>
//
// Only FAILED avatar blocks are touched — a degenerate window can never render,
// so deleting the row loses nothing. All other segments (and their generated
// assets) are left untouched.

import { getServerSupabase } from "@/lib/supabase/server";

const MIN_WINDOW = 0.2;
const GAP_EPS = 0.05;

type SegRow = {
  id: string;
  project_id: string;
  position: number;
  block_type: string;
  status: string;
  start_time: number | string | null;
  end_time: number | string | null;
  duration: number | string | null;
  script: string | null;
};

const num = (v: number | string | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function main() {
  const apply = process.argv.includes("--apply");
  const projArgIdx = process.argv.indexOf("--project");
  const onlyProject = projArgIdx >= 0 ? process.argv[projArgIdx + 1] : null;

  const sb = getServerSupabase();
  let q = sb
    .from("synthetic_segments")
    .select("id, project_id, position, block_type, status, start_time, end_time, duration, script")
    .eq("block_type", "avatar")
    .order("project_id")
    .order("position");
  if (onlyProject) q = q.eq("project_id", onlyProject);
  const { data: avatars, error } = await q;
  if (error) throw new Error(error.message);

  const bad = (avatars ?? []).filter((s: SegRow) => {
    const start = num(s.start_time);
    const end = num(s.end_time);
    return start === null || end === null || end - start <= MIN_WINDOW;
  }) as SegRow[];

  if (bad.length === 0) {
    console.log("No zero-window avatar segments found. Nothing to do.");
    return;
  }

  for (const seg of bad) {
    console.log(
      `\nproject ${seg.project_id} — avatar block position ${seg.position} (#${seg.position + 1})` +
      `\n  status=${seg.status} start=${seg.start_time} end=${seg.end_time} duration=${seg.duration}` +
      `\n  script: ${(seg.script ?? "").slice(0, 100)}`,
    );

    if (seg.status !== "failed") {
      console.log("  SKIP: status is not 'failed' — inspect manually before touching a live block.");
      continue;
    }

    // Neighbors by position within the project.
    const { data: sibs, error: sibErr } = await sb
      .from("synthetic_segments")
      .select("id, project_id, position, block_type, status, start_time, end_time, duration, script")
      .eq("project_id", seg.project_id)
      .in("position", [seg.position - 1, seg.position + 1]);
    if (sibErr) throw new Error(sibErr.message);
    const prev = (sibs ?? []).find((s: SegRow) => s.position === seg.position - 1) as SegRow | undefined;
    const next = (sibs ?? []).find((s: SegRow) => s.position === seg.position + 1) as SegRow | undefined;

    // Gap left behind once the block is deleted (0 when start==end).
    const gapStart = num(seg.start_time) ?? num(prev?.end_time ?? null);
    const gapEnd = num(seg.end_time) ?? num(next?.start_time ?? null);
    const gap = gapStart !== null && gapEnd !== null ? gapEnd - gapStart : 0;

    // Prefer extending a visual neighbor (re-rendered from the still at final
    // render, zero provider cost). Never extend avatar/split_2 (rendered clip
    // length would no longer match its window).
    const visual = (s?: SegRow) => (s && (s.block_type === "image" || s.block_type === "ai_clip") ? s : null);
    const absorber = gap > GAP_EPS ? visual(prev) ?? visual(next) : null;

    if (gap > GAP_EPS && !absorber) {
      console.log(`  SKIP: ${gap.toFixed(2)}s gap but no image/ai_clip neighbor to extend — needs manual review.`);
      continue;
    }

    const plan = [
      `delete avatar row ${seg.id}`,
      absorber
        ? `extend ${absorber.block_type} at position ${absorber.position} to cover ${gap.toFixed(2)}s gap`
        : `no gap to close (${gap.toFixed(2)}s)`,
    ].join("; ");
    if (!apply) {
      console.log(`  DRY-RUN would: ${plan}`);
      continue;
    }

    if (absorber) {
      const isPrev = absorber.position === seg.position - 1;
      const newStart = isPrev ? num(absorber.start_time) : gapStart;
      const newEnd = isPrev ? gapEnd : num(absorber.end_time);
      const script = isPrev
        ? [absorber.script, seg.script].filter((s) => s?.trim()).join(" ")
        : [seg.script, absorber.script].filter((s) => s?.trim()).join(" ");
      const { error: upErr } = await sb
        .from("synthetic_segments")
        .update({
          start_time: newStart,
          end_time: newEnd,
          duration: newEnd !== null && newStart !== null ? newEnd - newStart : absorber.duration,
          script,
        })
        .eq("id", absorber.id);
      if (upErr) throw new Error(upErr.message);
    }
    const { error: delErr } = await sb.from("synthetic_segments").delete().eq("id", seg.id);
    if (delErr) throw new Error(delErr.message);
    console.log(`  APPLIED: ${plan}`);
  }

  if (!apply) console.log("\nDry-run only. Re-run with --apply to fix.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
