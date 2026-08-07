import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { ChapterId, SectionId } from '../../domain/book/ids';
import { Section } from '../../domain/book/Section';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { IdGenerator } from '../ports/IdGenerator';
import { ChapterPrompt } from '../prompts/ChapterPrompt';

/** Adds a new section to an existing chapter after generation (synchronous AI call). */
export class AddSectionUseCase {
  constructor(
    private readonly books: BookRepository,
    private readonly ai: AiTextGenerator,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    projectId: string;
    chapterId: string;
    title: string;
    prompt: string;
    position: number;
  }): Promise<Result<{ sectionId: string }>> {
    const projectId = ProjectId.from(input.projectId);
    const book = await this.books.findByProject(projectId);
    if (!book) return Result.fail('Book not found');
    const chapterId = ChapterId.from(input.chapterId);
    const chapter = book.chapter(chapterId);
    if (!chapter) return Result.fail('Chapter not found');

    const ctx = await this.books.loadSharedContext(projectId);
    const completion = await this.ai.generate({
      model: 'claude-opus-4-8',
      system: ChapterPrompt.system({
        bookStrategy: ctx.bookStrategy,
        knowledgeBase: ctx.knowledgeBase,
        tone: ctx.tone,
        authorVoice: ctx.authorVoice,
        bookTitle: ctx.bookTitle ?? book.title ?? undefined,
      }),
      messages: [
        {
          role: 'user',
          content: ChapterPrompt.section({
            chapterTitle: chapter.title,
            sectionTitle: input.title,
            prompt: input.prompt,
            wordTarget: 800,
          }),
        },
      ],
      maxTokens: 3000,
      cacheControl: { systemPrefix: true },
      metadata: { projectId: input.projectId, stage: 'add-section' },
    });
    if (completion.isFail()) return Result.fail(completion.error.type);

    const sectionId = SectionId.from(this.ids.uuid());
    const section = Section.create({
      id: sectionId,
      chapterId: input.chapterId,
      position: input.position,
      title: input.title,
      prompt: input.prompt,
      content: completion.value.text,
      status: 'DONE',
    });
    const inserted = book.insertSection(chapterId, section);
    if (inserted.isFail()) return Result.fail(inserted.error);
    await this.books.save(book);
    return Result.ok({ sectionId: sectionId.value });
  }
}
