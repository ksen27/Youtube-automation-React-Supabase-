import { z } from 'zod';

/** Queue payload schemas — validated at the top of every processor (poison-message guard). */

export const ProjectJob = z.object({ projectId: z.string().uuid() });

export const VideoJob = z.object({
  projectId: z.string().uuid(),
  videoId: z.string().uuid(),
  inputHash: z.string().optional(),
});

export const WhisperJob = z.object({
  projectId: z.string().uuid(),
  videoId: z.string().uuid(),
  audioRef: z.string(),
});

export const ChapterResearchJob = z.object({
  projectId: z.string().uuid(),
  chapterId: z.string().uuid(),
  inputHash: z.string(),
});

export const ChapterJob = z.object({
  projectId: z.string().uuid(),
  chapterId: z.string().uuid(),
  inputHash: z.string(),
  mode: z.enum(['generate', 'regenerate', 'section']).default('generate'),
  instructions: z.string().optional(),
});

/** One per-chapter polishing job, fanned out by the polish-book controller. */
export const PolishChapterJob = z.object({
  projectId: z.string().uuid(),
  chapterId: z.string().uuid(),
});

export const ExportJob = z.object({
  projectId: z.string().uuid(),
  format: z.enum(['pdf', 'docx', 'both']).default('both'),
});

/**
 * Landing-page work. `publish` deploys the existing draft; `generate` rebuilds
 * the draft first and only deploys when the caller asked it to — that keeps
 * automatic post-export runs from pushing unreviewed copy to a live URL.
 */
export const LandingPageJob = z.object({
  projectId: z.string().uuid(),
  mode: z.enum(['generate', 'publish']).default('generate'),
  publish: z.boolean().default(false),
  /**
   * Re-derive this template's stored layout instead of reusing it.
   *
   * Off by default on purpose: reusing the stored layout is what keeps every
   * page on a template structurally identical, so re-deriving is a deliberate
   * act — after a prompt change, or when the captured layout is simply wrong.
   */
  rebuildLayout: z.boolean().default(false),
});

export type ProjectJob = z.infer<typeof ProjectJob>;
export type VideoJob = z.infer<typeof VideoJob>;
export type WhisperJob = z.infer<typeof WhisperJob>;
export type ChapterResearchJob = z.infer<typeof ChapterResearchJob>;
export type ChapterJob = z.infer<typeof ChapterJob>;
export type PolishChapterJob = z.infer<typeof PolishChapterJob>;
export type ExportJob = z.infer<typeof ExportJob>;
export type LandingPageJob = z.infer<typeof LandingPageJob>;

/**
 * Cloning a template site: render it, clean it, label it, store it.
 *
 * Its own queue rather than a mode of `landing-page`, because it is a different
 * unit of work with a different lifetime — once per template, not once per book
 * — and it must be able to fail visibly without a book's page depending on it.
 */
export const LandingTemplateJob = z.object({
  templateId: z.string().uuid(),
  ownerId: z.string().uuid(),
  sourceUrl: z.string().url(),
  /** Re-extract even when a template already exists at this pipeline version. */
  force: z.boolean().default(false),
});
export type LandingTemplateJob = z.infer<typeof LandingTemplateJob>;
