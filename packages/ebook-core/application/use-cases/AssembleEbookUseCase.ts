import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { KnowledgeRepository } from '../ports/repositories/KnowledgeRepository';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { AssembledDocument } from '../ports/services/DocumentExporter';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { Clock } from '../ports/Clock';
import type { ProjectJob } from '../dto/jobs.dto';
import { EXPORT_BUCKET } from './ExportEbookUseCase';

/**
 * Phase 14: assemble a deterministic document model with front matter (title
 * page, copyright, TOC), body (chapters + sections) and back matter.
 */
export class AssembleEbookUseCase {
  constructor(
    private readonly books: BookRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly clock: Clock,
    private readonly storage: ObjectStorage,
    private readonly projects: ProjectRepository,
  ) {}

  async execute(cmd: ProjectJob): Promise<Result<AssembledDocument>> {
    const projectId = ProjectId.from(cmd.projectId);
    const book = await this.books.findByProject(projectId);
    if (!book) return Result.fail('Book not found');
    const project = await this.projects.findById(projectId);
    const isCooking = project?.options.isCooking ?? false;

    const incomplete = book.chapters.filter((c) => c.status !== 'DONE');
    if (incomplete.length > 0) {
      return Result.fail(`Cannot assemble: ${incomplete.length} chapter(s) not generated`);
    }

    const strategy = await this.knowledge.getBookStrategy(projectId);
    const orderedChapters = [...book.chapters].sort((a, b) => a.position - b.position);
    const year = this.clock.now().getFullYear();

    // Inline the generated cover art as a base64 data URI (rendered full-bleed
    // behind the cover text). It must be inlined, not a network URL, because:
    //   - PDF: Paged.js re-chunks the DOM after the initial network-idle load, and
    //     a background image fetched over the network often fails to repaint into
    //     the regenerated page boxes — so the cover silently drops out of the PDF.
    //   - DOCX: the docx library embeds images from raw bytes, which it recovers
    //     by decoding this data URI.
    // Best-effort: a missing/unreadable cover just falls back to the plain cover.
    let coverImage: string | undefined;
    if (book.coverImagePath) {
      const inlined = await this.storage.getDataUri(EXPORT_BUCKET, book.coverImagePath);
      if (inlined.isOk()) coverImage = inlined.value;
    }

    // Inline each chapter's illustrations as base64 data URIs (same network-fetch
    // reasons as the cover). Best-effort: an unreadable illustration is dropped.
    const illustrationsByChapter = new Map<string, Array<{ dataUri: string; alt: string }>>();
    for (const ch of orderedChapters) {
      const ills = book.illustrationsForChapter(ch.id.value);
      if (ills.length === 0) continue;
      const inlined: Array<{ dataUri: string; alt: string }> = [];
      for (const ill of ills) {
        const uri = await this.storage.getDataUri(EXPORT_BUCKET, ill.storagePath);
        if (uri.isOk()) inlined.push({ dataUri: uri.value, alt: `${cleanChapterTitle(ch.title)} illustration` });
      }
      if (inlined.length > 0) illustrationsByChapter.set(ch.id.value, inlined);
    }

    const doc: AssembledDocument = {
      bookType: isCooking ? 'cooking' : 'normal',
      title: strategy?.title ?? 'Generated Ebook',
      subtitle: strategy?.subtitle ?? '',
      promise: strategy?.corePromise ?? '',
      ...(coverImage ? { coverImage } : {}),
      author: strategy?.author?.trim() || 'The Author',
      copyright: `© ${year}. All rights reserved. Generated from publicly available YouTube content.`,
      tableOfContents: orderedChapters.map((c) => c.title),
      // Front matter (Foreword, Introduction). Strip any leading heading so the content
      // doesn't repeat the section title the renderer already prints.
      frontMatter: book
        .frontMatter()
        .filter((s) => s.status === 'DONE' && s.content)
        .map((s) => ({ title: s.title, content: stripLeadingHeadings(s.content ?? '') })),
      chapters: orderedChapters.map((c) => {
        const ills = illustrationsByChapter.get(c.id.value);
        return {
          title: cleanChapterTitle(c.title),
          // Prose chapters: strip every heading so the body carries no in-chapter
          // subtitles. Recipe chapters store structured JSON — pass it through verbatim
          // for the cookbook renderer to parse.
          content: isCooking ? (c.content ?? '') : stripAllHeadings(c.content ?? ''),
          sections: [...c.sections]
            .sort((a, b) => a.position - b.position)
            .map((s) => ({ title: s.title, content: s.content ?? '' })),
          ...(ills && ills.length > 0 ? { illustrations: ills } : {}),
        };
      }),
      // Back matter (Conclusion, plus any author-added FAQ/resources/glossary/bonus).
      backMatter: book
        .backMatter()
        .filter((s) => s.status === 'DONE' && s.content)
        .map((s) => ({ title: s.title, content: stripLeadingHeadings(s.content ?? '') })),
    };
    return Result.ok(doc);
  }
}

/** Strip a leading "Chapter N:" / "Chapter N —" prefix; the layout prints the number itself. */
function cleanChapterTitle(title: string): string {
  return title.replace(/^\s*chapter\s+\d+\s*[:.\-–—]?\s*/i, '').trim() || title.trim();
}

/**
 * Chapters must begin with prose. Remove up to two leading Markdown heading lines
 * (a title echo and/or a subtitle/tagline) so the body doesn't duplicate the
 * chapter title the renderer already prints.
 */
function stripLeadingHeadings(content: string): string {
  const lines = content.split(/\r?\n/);
  let removed = 0;
  while (removed < 2) {
    let i = 0;
    while (i < lines.length && (lines[i] ?? '').trim() === '') i++;
    const line = lines[i];
    if (line !== undefined && /^#{1,6}\s+\S/.test(line.trim())) {
      lines.splice(0, i + 1);
      removed++;
    } else break;
  }
  return lines.join('\n').replace(/^\s+/, '');
}

/**
 * Remove EVERY Markdown heading line from a chapter body. Chapters are rendered as
 * one continuous narrative under a single title; any in-chapter "##" heading reads
 * as an unwanted subtitle, so we drop them all and collapse the blank lines left behind.
 */
function stripAllHeadings(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !/^\s*#{1,6}\s+/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '');
}
