import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { BookSectionId } from '../../domain/book/ids';
import { BookSection, ExtraContentKind, placementOf } from '../../domain/book/BookSection';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { IdGenerator } from '../ports/IdGenerator';
import { ExtraContentPrompt } from '../prompts/ExtraContentPrompt';

/**
 * The default front/back matter every book gets, in reading order:
 * Preface (front), Conclusion → Acknowledgments (back). The Preface folds the
 * former Foreword and Introduction into one section.
 * Iteration order sets each section's position within its placement lane.
 */
const DEFAULT_SECTIONS: { kind: ExtraContentKind; title: string }[] = [
  { kind: ExtraContentKind.FOREWORD, title: 'Preface' },
  { kind: ExtraContentKind.CONCLUSION, title: 'Conclusion' },
  { kind: ExtraContentKind.ACKNOWLEDGMENTS, title: 'Acknowledgments' },
];

/**
 * Gives every generated book a real publishing structure: a Dedication, Foreword
 * and Introduction (front matter), and a Conclusion and Acknowledgments (back
 * matter). Runs at the ASSEMBLING stage, before the document is assembled.
 * Idempotent — a section already filled is left untouched, so retries and the
 * export re-assembly are safe.
 */
export class GenerateFrontBackMatterUseCase {
  constructor(
    private readonly books: BookRepository,
    private readonly ai: AiTextGenerator,
    private readonly ids: IdGenerator,
  ) {}

  async execute(cmd: { projectId: string }): Promise<Result<{ generated: number }>> {
    const projectId = ProjectId.from(cmd.projectId);
    const book = await this.books.findByProject(projectId);
    if (!book) return Result.fail('Book not found');

    const ctx = await this.books.loadSharedContext(projectId);
    const tableOfContents = [...book.chapters].sort((a, b) => a.position - b.position).map((c) => c.title);

    // Decide what needs generating and assign positions SYNCHRONOUSLY first, so
    // the per-placement position counter (book.nextSectionPosition) is computed
    // deterministically before any concurrency. The actual generations are then
    // independent, so run them in parallel rather than one Opus call at a time.
    const pending: { def: (typeof DEFAULT_SECTIONS)[number]; section: BookSection }[] = [];
    for (const def of DEFAULT_SECTIONS) {
      const existing = book.bookSections.find((s) => s.kind === def.kind);
      if (existing?.status === 'DONE' && existing.content) continue; // idempotent

      const section =
        existing ??
        BookSection.create({
          id: BookSectionId.from(this.ids.uuid()),
          bookId: book.id.value,
          kind: def.kind,
          position: book.nextSectionPosition(placementOf(def.kind)),
          title: def.title,
          prompt: null,
        });
      if (!existing) book.addBookSection(section);
      pending.push({ def, section });
    }

    // Publishing matter (Preface/Conclusion/Acknowledgments) is boilerplate, not
    // core content, so Sonnet is plenty — and far faster than Opus.
    const results = await Promise.all(
      pending.map(({ def, section }) => {
        const prompt = ExtraContentPrompt.build({
          kind: def.kind,
          bookTitle: book.title ?? 'Untitled',
          bookStrategy: ctx.bookStrategy,
          knowledgeBase: ctx.knowledgeBase,
          tone: ctx.tone,
          authorVoice: ctx.authorVoice,
          tableOfContents,
        });
        return this.ai
          .generate({
            model: 'claude-sonnet-4-6',
            system: prompt.system,
            messages: [{ role: 'user', content: prompt.user }],
            maxTokens: prompt.maxTokens,
            cacheControl: { systemPrefix: true },
            metadata: { projectId: cmd.projectId, stage: 'front-back-matter' },
          })
          .then((completion) => ({ section, completion }));
      }),
    );

    for (const { section, completion } of results) {
      if (completion.isFail()) return Result.fail(completion.error.type);
      section.fill(completion.value.text);
    }

    const generated = pending.length;
    if (generated > 0) await this.books.save(book);
    return Result.ok({ generated });
  }
}
