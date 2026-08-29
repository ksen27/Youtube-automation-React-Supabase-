import Link from "next/link";
import { BookOpen } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { container, ownerId } from "@/lib/ebook/server";
import { badgeVariantFor, humanizeStatus, isRunningStatus } from "./_shared";
import { NewBookForm } from "./new-book-form";

export const dynamic = "force-dynamic";

// Ebooks — the third product, alongside Celebrity Videos (/dashboard) and AI
// Avatar (/avatar). Turns a YouTube channel into a ~100-page book through the
// 15-phase pipeline in packages/ebook-core.

interface BookRow {
  id: string;  status: string;
  createdAt: string;
}

// NOTE: ProjectListItem carries no book title — the title is decided by the
// pipeline (book strategy) and lives on the book aggregate, not the project row.
// The list therefore identifies a book by its channel until it is opened.
async function loadReferences() {
  try {
    return await container().repositories.references.list(ownerId());
  } catch {
    // Same reasoning as loadBooks below: an unconfigured env or an unapplied
    // migration renders an empty picker, not a 500.
    return [];
  }
}

async function loadBooks(): Promise<{ books: BookRow[]; maxActive: number; running: number }> {
  try {
    const c = container();
    const owner = ownerId();
    const rows = await c.repositories.projects.listByOwner(owner);
    const books: BookRow[] = rows.map((r) => ({
      id: r.id,      status: r.status,
      createdAt: r.createdAt,
    }));
    return {
      books,
      maxActive: c.env.MAX_ACTIVE_PROJECTS_PER_USER,
      running: books.filter((b) => isRunningStatus(b.status)).length,
    };
  } catch {
    // An unconfigured ebook env (no ANTHROPIC_API_KEY, migrations not applied)
    // must render an empty page rather than a 500 — the form below still
    // explains what to do, and the video products are unaffected.
    return { books: [], maxActive: 0, running: 0 };
  }
}

export default async function BooksPage() {
  const [{ books, maxActive, running }, references] = await Promise.all([loadBooks(), loadReferences()]);

  return (
    <div className="px-6 lg:px-8 py-8 max-w-7xl mx-auto space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Ebooks</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Turn a YouTube channel into a finished book — researched from its videos
          and its audience&apos;s comments, then exported as PDF and DOCX.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Start a new book</CardTitle>
          <CardDescription>
            Point it at a channel and give the book a title.
            {maxActive > 0 && (
              <>
                {" "}
                {running} of {maxActive} running — anything beyond that is queued
                and starts automatically.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NewBookForm references={references} />
        </CardContent>
      </Card>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight text-fg">Your books</h2>
        {books.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="h-5 w-5" />}
            title="No books yet"
            description="Submit a YouTube channel above and the pipeline will research it, outline a book, write every chapter, and export it."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {books.map((b) => (
              <Card key={b.id} interactive className="h-full overflow-hidden group">
                <Link href={`/books/${b.id}`} className="block">
                  <CardHeader>
                    <CardTitle className="truncate text-fg group-hover:text-brand-300 transition-colors">
                    </CardTitle>
                    <CardDescription className="text-xs truncate">
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <Badge variant={badgeVariantFor(b.status)}>
                      {humanizeStatus(b.status)}
                    </Badge>
                    <p className="text-xs text-fg-subtle">
                      {new Date(b.createdAt).toLocaleString()}
                    </p>
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
