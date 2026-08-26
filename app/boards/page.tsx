import Link from "next/link";
import { KanbanSquare, Users, Layers, Archive } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { listBoards } from "@/lib/boards/service";
import type { BoardSummary } from "@/lib/boards/types";
import { NewBoardForm } from "./new-board-form";

export const dynamic = "force-dynamic";

// Boards — the team's project-management surface, alongside the video products.
// A board is independent of the render pipeline; it may optionally reference a
// video project (boards.project_id) when a team wants to track the work around
// one specific video.

async function loadBoards(): Promise<BoardSummary[]> {
  try {
    // Private boards are reachable by direct link but stay out of the list, so
    // the index is the shared workspace view.
    return (await listBoards()).filter((b) => b.visibility !== "private");
  } catch {
    // An unconfigured Supabase or an unapplied migration must render an empty
    // page, not a 500 — the create form below still explains what to do, and
    // the other products are unaffected.
    return [];
  }
}

export default async function BoardsPage() {
  const boards = await loadBoards();

  return (
    <div className="px-6 lg:px-8 py-8 max-w-7xl mx-auto space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Boards</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Plan work in columns and cards — ideas, production, review, done.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Start a new board</CardTitle>
          <CardDescription>
            It opens with the usual columns and a label palette; rename or remove
            anything you do not need.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NewBoardForm />
        </CardContent>
      </Card>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight text-fg">Your boards</h2>

        {boards.length === 0 ? (
          <EmptyState
            icon={<KanbanSquare className="h-5 w-5" />}
            title="No boards yet"
            description="Create one above to start tracking work across columns."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {boards.map((board) => (
              <Card key={board.id} interactive className="h-full group">
                <Link href={`/boards/${board.id}`} className="block">
                  <CardHeader>
                    <CardTitle className="truncate text-fg group-hover:text-brand-300 transition-colors">
                      {board.name}
                    </CardTitle>
                    <CardDescription className="line-clamp-2 text-xs">
                      {board.description || "No description"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                    <span className="inline-flex items-center gap-1">
                      <Layers className="h-3.5 w-3.5" />
                      {board.listCount} lists
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <KanbanSquare className="h-3.5 w-3.5" />
                      {board.cardCount} cards
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" />
                      {board.memberCount}
                    </span>
                    {board.archivedAt && (
                      <Badge variant="warning" className="ml-auto gap-1">
                        <Archive className="h-3 w-3" />
                        Archived
                      </Badge>
                    )}
                  </CardContent>
                </Link>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
