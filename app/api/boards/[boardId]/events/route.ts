import type { NextRequest } from "next/server";
import { getBoardRevision } from "@/lib/boards/service";
import { resolveBoardAccess } from "@/lib/boards/access";
import { getActorId, parseBoardId } from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/boards/:id/events — Server-Sent Events for live board updates.
 *
 * WHY SSE: this app already streams progress this way (see
 * app/api/books/projects/[id]/events/route.ts), so boards reuse the existing
 * realtime approach rather than introducing a second architecture — Supabase
 * Realtime would mean exposing the tables to the browser client, which the
 * shared-password model (server-side service role only) deliberately avoids.
 *
 * WHAT IS SENT: only `{ revision }`, never board data. Every child write bumps
 * `boards.revision` via a trigger, so this poll is one indexed single-column
 * read, and the client turns a change into a React Query invalidation. That
 * keeps the stream O(1) in board size, and means the refetch path is the same
 * one used everywhere else — no second, subtly different copy of the merge
 * logic to keep in sync.
 *
 * CONFLICTS: last-write-wins, as the brief allows. Two people editing the same
 * field is rare on a board; two people moving different cards is the common
 * case and is already conflict-free, because a move writes one row.
 */
const POLL_MS = 2000;
const HEARTBEAT_MS = 25_000;

export async function GET(req: NextRequest, ctx: { params: Promise<{ boardId: string }> }) {
  const { boardId } = await ctx.params;

  // Same access check as every other board route — a stream is a read.
  try {
    await resolveBoardAccess(parseBoardId(boardId), getActorId(req));
  } catch {
    return new Response("event: error\ndata: {\"error\":\"not_found\"}\n\n", {
      status: 404,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let lastRevision = -1;
      let lastSendAt = 0;
      // The client can disconnect at any moment, closing the controller out
      // from under the interval. Everything below no-ops once that happens.
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
          lastSendAt = Date.now();
        } catch {
          stop();
        }
      };

      const tick = async (): Promise<void> => {
        if (closed) return;
        try {
          const revision = await getBoardRevision(boardId);
          if (revision == null) {
            send({ error: "not_found" });
            stop();
            return;
          }
          if (revision !== lastRevision) {
            lastRevision = revision;
            send({ revision });
          } else if (Date.now() - lastSendAt > HEARTBEAT_MS) {
            // Proxies drop idle connections; a comment line keeps the stream
            // alive without looking like an update to the client.
            if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
            lastSendAt = Date.now();
          }
        } catch {
          stop(); // transient DB error — end the stream rather than spin
        }
      };

      req.signal.addEventListener("abort", stop);
      const interval = setInterval(() => void tick(), POLL_MS);
      await tick();
    },
    cancel() {
      // Reader cancelled; start()'s abort listener already stopped the timer.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
