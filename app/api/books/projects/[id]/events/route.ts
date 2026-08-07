import { ProjectId } from '@ebook/core';
import { container, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/projects/:id/events — Server-Sent Events stream of pipeline progress.
 * Polls the project status (a production build would subscribe to the Redis
 * pub/sub channel published by the workers' QueueEvents bridge).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const repo = container().repositories.projects;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let lastStatus = '';
      // Track the serialized pending-counts too: during the per-video phase the
      // project status sits on FETCHING_VIDEO_DATA while the VIDEO_PIPELINE barrier
      // counts down, so we must emit on pending changes to drive a live counter.
      let lastPending = '';
      // The client can disconnect (tab close / navigation) at any time, which
      // closes the controller out from under us. Track that and make every
      // enqueue/close a no-op afterwards so the polling interval can't throw
      // ERR_INVALID_STATE ("Controller is already closed").
      let closed = false;

      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          /* already closed by the runtime on disconnect */
        }
      };

      const send = (data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          stop(); // controller went away between the check and the enqueue
        }
      };

      const tick = async (): Promise<boolean> => {
        const project = await repo.findById(ProjectId.from(id));
        if (!project || project.ownerId !== userId) {
          send({ error: 'not_found' });
          return true;
        }
        const pendingJson = JSON.stringify(project.pendingCounts);
        if (project.status.value !== lastStatus || pendingJson !== lastPending) {
          lastStatus = project.status.value;
          lastPending = pendingJson;
          send({ status: lastStatus, pending: project.pendingCounts });
        }
        return lastStatus === 'COMPLETED' || lastStatus === 'FAILED';
      };

      const tickOnce = async (): Promise<void> => {
        if (closed) return;
        try {
          if (await tick()) stop();
        } catch {
          stop(); // DB/transient error — end the stream rather than spin
        }
      };

      // End promptly when the client aborts the request.
      req.signal.addEventListener('abort', stop);

      const interval = setInterval(() => void tickOnce(), 1500);
      await tickOnce();
    },
    cancel() {
      // Reader cancelled (disconnect). start()'s abort listener also calls stop;
      // the `closed` guard makes this idempotent.
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
