import { notFound } from "next/navigation";
import { getBoardSnapshot } from "@/lib/boards/service";
import type { BoardSnapshot } from "@/lib/boards/types";
import { BoardView } from "@/components/boards/board-view";

export const dynamic = "force-dynamic";

// The board page renders its first paint on the server — the snapshot is one
// bounded set of queries (see getBoardSnapshot), so there is no reason to make
// the browser wait for a round trip before it can see the columns. That payload
// is then handed to React Query as `initialData`, and the client takes over for
// live updates and mutations.
//
// Access is already established: proxy.ts gates every route behind the shared
// password, and the API routes re-check per request.

export default async function BoardPage({ params }: { params: Promise<{ boardId: string }> }) {
  const { boardId } = await params;

  let snapshot: BoardSnapshot;
  try {
    snapshot = await getBoardSnapshot(boardId);
  } catch {
    // Missing board, malformed id, or an unapplied migration — all of which
    // mean "there is no board here" from the visitor's point of view.
    notFound();
  }

  return <BoardView boardId={boardId} initialSnapshot={snapshot} />;
}
