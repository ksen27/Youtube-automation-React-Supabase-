"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { KanbanSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { boardsApi, writeStoredActor } from "@/lib/boards/client";

// Creating a board asks for two things: what it is called, and who you are.
//
// The second is not busywork — the app authenticates a team through one shared
// password (lib/auth.ts), so a board has no way to know who created it unless
// the creator says so. That name becomes the board's owner, and it is stored
// locally as this browser's identity on the new board so the first card and
// comment are attributed correctly without a second prompt.

export function NewBoardForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && ownerName.trim().length > 0 && !submitting;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const board = await boardsApi.createBoard({
        name: name.trim(),
        ownerName: ownerName.trim(),
        description: description.trim() || undefined,
      });

      // The API returns the board; its owner is the member row the SQL function
      // created, so adopt that as this browser's identity before navigating.
      if (board.ownerMemberId) writeStoredActor(board.id, board.ownerMemberId);

      router.push(`/boards/${board.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the board");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="board-name">Board name</Label>
          <Input
            id="board-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Q3 video pipeline"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="board-owner">Your name</Label>
          <Input
            id="board-owner"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            placeholder="e.g. Sara"
          />
          <p className="text-xs text-fg-subtle">
            You become the board owner. Add teammates once it is open.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="board-description">Description (optional)</Label>
        <Input
          id="board-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this board for?"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="gradient" size="lg" disabled={!canSubmit}>
          <KanbanSquare className="h-4 w-4" />
          {submitting ? "Creating…" : "Create board"}
        </Button>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </form>
  );
}
