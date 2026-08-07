import { ProjectId } from '@ebook/core';
import { container, json, error, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

// GET /api/projects/:id/videos — per-video processing state, for the live
// pipeline view's item-level detail (which video is being processed).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const c = container();
  const projectId = ProjectId.from(id);
  const project = await c.repositories.projects.findById(projectId);
  if (!project) return error('Not found', 404);
  if (project.ownerId !== userId) return error('Forbidden', 403);

  const videos = await c.repositories.videos.findByProject(projectId);
  return json({
    videos: [...videos]
      .sort((a, b) => a.position - b.position)
      .map((v) => ({
        id: v.id.value,
        title: v.title,
        position: v.position,
        status: v.status,
        // Per-phase flags so each video sub-step can show its own real state.
        hasTranscript: v.hasTranscript(),
        transcriptSource: v.transcriptSource ?? null,
        needsWhisper: v.needsWhisperFallback(),
        hasSummary: v.summary !== undefined,
        commentCount: v.comments.length,
      })),
  });
}
