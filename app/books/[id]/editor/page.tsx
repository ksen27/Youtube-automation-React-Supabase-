import { ChapterEditor } from "./chapter-editor";

export const dynamic = "force-dynamic";

// Post-generation editing: rewrite a chapter by hand, or hand Claude
// instructions and regenerate it.
export default async function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChapterEditor projectId={id} />;
}
