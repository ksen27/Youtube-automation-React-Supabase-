import { notFound } from "next/navigation";
import { ProjectId } from "@ebook/core";
import { container, ownerId } from "@/lib/ebook/server";
import { BookDetail } from "./book-detail";

export const dynamic = "force-dynamic";

// One book: live pipeline progress while it runs, then the finished book with
// its chapters, exports and landing page.
export default async function BookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let initialStatus = "CREATED";
  let initialError: string | null = null;
  try {
    const c = container();
    const project = await c.repositories.projects.findById(ProjectId.from(id));
    if (!project || project.ownerId !== ownerId()) notFound();
    initialStatus = project.status.value;
    initialError = project.error ?? null;
  } catch {
    // Ebook env not configured / migrations not applied. Render the client shell
    // anyway — it surfaces the API error rather than showing a blank 500.
  }

  return <BookDetail id={id} initialStatus={initialStatus} initialError={initialError} />;
}
