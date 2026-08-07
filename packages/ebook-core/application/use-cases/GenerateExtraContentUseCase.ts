import { z } from 'zod';
import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { BookSectionId } from '../../domain/book/ids';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import { ExtraContentPrompt } from '../prompts/ExtraContentPrompt';

export const ExtraContentJob = z.object({
  projectId: z.string().uuid(),
  sectionId: z.string().uuid(),
});
export type ExtraContentJob = z.infer<typeof ExtraContentJob>;

/** Async generation of a long-form extra-content unit (e.g. Bonus Chapter). Idempotent. */
export class GenerateExtraContentUseCase {
  constructor(
    private readonly books: BookRepository,
    private readonly ai: AiTextGenerator,
  ) {}

  async execute(cmd: ExtraContentJob): Promise<Result<{ skipped: boolean }>> {
    const projectId = ProjectId.from(cmd.projectId);
    const book = await this.books.findByProject(projectId);
    if (!book) return Result.fail('Book not found');
    const section = book.bookSection(BookSectionId.from(cmd.sectionId));
    if (!section) return Result.fail('Book section not found');
    if (section.status === 'DONE') return Result.ok({ skipped: true }); // idempotent

    const ctx = await this.books.loadSharedContext(projectId);
    const prompt = ExtraContentPrompt.build({
      kind: section.kind,
      bookTitle: book.title ?? 'Untitled',
      bookStrategy: ctx.bookStrategy,
      knowledgeBase: ctx.knowledgeBase,
      tone: ctx.tone,
      authorVoice: ctx.authorVoice,
      tableOfContents: [...book.chapters].sort((a, b) => a.position - b.position).map((c) => c.title),
      ...(section.prompt ? { userPrompt: section.prompt } : {}),
    });
    const completion = await this.ai.generate({
      model: 'claude-opus-4-8',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      maxTokens: prompt.maxTokens,
      cacheControl: { systemPrefix: true },
      metadata: { projectId: cmd.projectId, stage: 'extra-content' },
    });
    if (completion.isFail()) return Result.fail(completion.error.type);

    section.fill(completion.value.text);
    await this.books.save(book);
    return Result.ok({ skipped: false });
  }
}
