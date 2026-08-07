// Shared presentation helpers for the Ebooks product.
//
// Deliberately separate from app/projects/[id]/_shared.ts: the video engines use
// lowercase statuses ('rendering', 'completed'), the ebook pipeline uses the
// uppercase 15-phase state machine ('GENERATING_CHAPTERS'). One mapper covering
// both would be a lookup table of two unrelated vocabularies.

export type BadgeVariant =
  | "default" | "secondary" | "success" | "warning" | "destructive" | "info" | "outline";

/** Terminal states — nothing further will happen without user action. */
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** Waiting on a free concurrency slot rather than actually running. */
export function isQueuedStatus(s: string): boolean {
  return s === "QUEUED";
}

export function isRunningStatus(s: string): boolean {
  return !TERMINAL.has(s) && !isQueuedStatus(s) && s !== "CREATED";
}

/** In the pipeline at all — queued, or actively working. */
export function isActiveStatus(s: string): boolean {
  return !TERMINAL.has(s);
}

export function badgeVariantFor(status: string): BadgeVariant {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "CANCELLED") return "secondary";
  if (status === "PARTIAL") return "warning";
  if (isQueuedStatus(status)) return "secondary";
  if (isRunningStatus(status)) return "info";
  return "default";
}

/** 'GENERATING_CHAPTERS' → 'Generating chapters'. */
export function humanizeStatus(status: string): string {
  const words = status.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The pipeline's stages in order, for the progress view. Mirrors the
 * ProjectStatus transition table in
 * packages/ebook-core/domain/project/ProjectStatus.ts — if a stage is added
 * there, add it here or the status simply won't light up a step.
 */
export const PIPELINE_STAGES: { status: string; label: string }[] = [
  { status: "INGESTING_CHANNEL", label: "Reading the channel" },
  { status: "FETCHING_VIDEO_DATA", label: "Fetching video data" },
  { status: "FETCHING_TRANSCRIPTS", label: "Fetching transcripts" },
  { status: "TRANSCRIBING_FALLBACK", label: "Transcribing audio" },
  { status: "SUMMARIZING_VIDEOS", label: "Extracting knowledge" },
  { status: "ANALYZING_COMMENTS", label: "Analyzing comments" },
  { status: "BUILDING_KNOWLEDGE_BASE", label: "Building knowledge base" },
  { status: "GENERATING_BOOK_STRATEGY", label: "Planning the book" },
  { status: "GENERATING_OUTLINE", label: "Writing the outline" },
  { status: "GENERATING_CHAPTER_RESEARCH", label: "Researching chapters" },
  { status: "GENERATING_CHAPTERS", label: "Writing chapters" },
  { status: "POLISHING_BOOK", label: "Polishing" },
  { status: "ASSEMBLING", label: "Assembling" },
  { status: "EXPORTING", label: "Exporting PDF + DOCX" },
];

/** Index of the current stage, or -1 when the status isn't a pipeline stage. */
export function stageIndex(status: string): number {
  return PIPELINE_STAGES.findIndex((s) => s.status === status);
}

/** Mirror of the backend chapter-count formula (round(pages/7), clamped 2–14). */
export function estimateChapters(pages: number): number {
  const p = Number.isFinite(pages) ? pages : 100;
  return Math.max(2, Math.min(14, Math.round(p / 7)));
}

/** Clamp a (possibly NaN) number input to the DTO's allowed range. */
export function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
