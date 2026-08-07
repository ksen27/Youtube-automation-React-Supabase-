import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { BookSectionId } from '../../domain/book/ids';
import { BookSection, ExtraContentKind, placementOf, isLongForm } from '../../domain/book/BookSection';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { JobQueue } from '../ports/services/JobQueue';
import type { IdGenerator } from '../ports/IdGenerator';
import { ExtraContentPrompt } from '../prompts/ExtraContentPrompt';

export interface AddExtraContentInput {
  projectId: string;
  kind: ExtraContentKind;
  title: string;
  userPrompt?: string;
}

/**
 * Phase 13. Adds an extra-content unit (front/back matter). Short types are
 * generated inline (Opus); a Bonus Chapter is full-length and is generated
 * asynchronously via the extra-content queue.
 */
export class AddExtraContentUseCase {
  constructor(
    private readonly books: BookRepository,
    private readonly ai: AiTextGenerator,
    private readonly queue: JobQueue,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: AddExtraContentInput): Promise<Result<{ sectionId: string; queued: boolean }>> {
    const projectId = ProjectId.from(input.projectId);
    const book = await this.books.findByProject(projectId);
    if (!book) return Result.fail('Book not found');

    const sectionId = BookSectionId.from(this.ids.uuid());
    const section = BookSection.create({
      id: sectionId,
      bookId: book.id.value,
      kind: input.kind,
      position: book.nextSectionPosition(placementOf(input.kind)),
      title: input.title,
      prompt: input.userPrompt ?? null,
    });
    book.addBookSection(section);

    // Long-form (bonus chapter) → persist as PENDING and generate off the request path.
    if (isLongForm(input.kind)) {
      await this.books.save(book);
      await this.queue.enqueue(
        'extra-content',
        { projectId: input.projectId, sectionId: sectionId.value },
        { jobId: `extra-content:${input.projectId}:${sectionId.value}` },
      );
      return Result.ok({ sectionId: sectionId.value, queued: true });
    }

    // Short types → generate inline.
    const ctx = await this.books.loadSharedContext(projectId);
    const prompt = ExtraContentPrompt.build({
      kind: input.kind,
      bookTitle: book.title ?? 'Untitled',
      bookStrategy: ctx.bookStrategy,
      knowledgeBase: ctx.knowledgeBase,
      tone: ctx.tone,
      authorVoice: ctx.authorVoice,
      tableOfContents: [...book.chapters].sort((a, b) => a.position - b.position).map((c) => c.title),
      ...(input.userPrompt ? { userPrompt: input.userPrompt } : {}),
    });
    const completion = await this.ai.generate({
      model: 'claude-opus-4-8',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      maxTokens: prompt.maxTokens,
      cacheControl: { systemPrefix: true },
      metadata: { projectId: input.projectId, stage: 'extra-content' },
    });
    if (completion.isFail()) return Result.fail(completion.error.type);

    section.fill(completion.value.text);
    await this.books.save(book);
    return Result.ok({ sectionId: sectionId.value, queued: false });
  }
}
