import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { ChapterId } from '../../domain/book/ids';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { KnowledgeRepository } from '../ports/repositories/KnowledgeRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { Clock } from '../ports/Clock';
import { PolishPrompt } from '../prompts/PolishPrompt';
import type { PolishChapterJob } from '../dto/jobs.dto';

/**
 * Phase 12 (Sonnet). Polishes ONE chapter for flow, transitions, consistency and
 * readability. Fanned out by StartBookPolishUseCase so chapters polish in
 * parallel instead of in a serial loop. The previous chapter's title is read
 * from the outline order (not threaded through state), preserving smooth
 * handoffs while keeping each job independent. Persists only this chapter via
 * saveChapter so concurrent jobs don't clobber one another. Idempotent: a
 * chapter whose content is already polished is skipped.
 */
export class PolishChapterUseCase {
  constructor(
    private readonly books: BookRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly ai: AiTextGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(cmd: PolishChapterJob): Promise<Result<{ polished: boolean }>> {
    const projectId = ProjectId.from(cmd.projectId);
    const chapterId = ChapterId.from(cmd.chapterId);

    const book = await this.books.findByProject(projectId);
    if (!book) return Result.fail('Book not found');
    const chapter = book.chapter(chapterId);
    if (!chapter) return Result.fail('Chapter not found');

    // Nothing to polish, or already polished for this version — idempotent skip.
    // (Once polished, inputHash is `polished:...`; the guard is stable across
    // retries because it does not depend on the version, which polishing bumps.)
    if (!chapter.content || chapter.inputHash?.startsWith('polished:')) {
      return Result.ok({ polished: false });
    }

    const strategy = await this.knowledge.getBookStrategy(projectId);
    const tone = strategy?.tone ?? 'professional';
    const authorVoice = strategy?.authorVoice ?? 'authoritative and clear';

    // Previous chapter by outline position — for a smooth handoff in the prompt.
    const ordered = [...book.chapters].sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((c) => c.id.equals(chapterId));
    const previousChapterTitle = index > 0 ? (ordered[index - 1]?.title ?? null) : null;

    const completion = await this.ai.generate({
      model: 'claude-sonnet-4-6',
      system: PolishPrompt.system({ tone, authorVoice }),
      messages: [{ role: 'user', content: PolishPrompt.user({ title: chapter.title, content: chapter.content, previousChapterTitle }) }],
      maxTokens: 8000,
      metadata: { projectId: cmd.projectId, stage: 'polish-chapter' },
    });
    if (completion.isFail()) return Result.fail(completion.error.type);

    // Polish returns surgical find/replace edits, not the whole chapter, so we
    // apply them onto the existing content. An unparseable response or absent
    // `find` span degrades to "no change" rather than blocking the pipeline.
    const edits = PolishPrompt.parseEdits(completion.value.text);
    const polished = PolishPrompt.applyEdits(chapter.content, edits);

    const applied = book.regenerateChapter(
      chapter.id,
      { content: polished.text, inputHash: `polished:v${chapter.version}` },
      this.clock.now(),
    );
    if (applied.isFail()) return Result.fail(applied.error);

    await this.books.saveChapter(book.id, chapter);
    return Result.ok({ polished: true });
  }
}
