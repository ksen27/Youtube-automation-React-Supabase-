import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { ChapterId } from '../../domain/book/ids';
import type { Book } from '../../domain/book/Book';
import type { Chapter } from '../../domain/book/Chapter';
import type { BookRepository, SharedChapterContext } from '../ports/repositories/BookRepository';
import type { KnowledgeRepository } from '../ports/repositories/KnowledgeRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { Clock } from '../ports/Clock';
import { ChapterPrompt } from '../prompts/ChapterPrompt';
import { RecipePrompt } from '../prompts/RecipePrompt';
import { RecipeSchema, serializeRecipe } from '../../domain/book/Recipe';
import { parseJsonCompletion } from '../prompts/parse';
import type { ChapterJob } from '../dto/jobs.dto';

/** Run the expand pass when the draft lands below this fraction of its target. */
const EXPAND_THRESHOLD = 0.9;

/**
 * Phase 11. Writes one chapter using the 9-part structure, fed by the book
 * strategy + knowledge base (cached system prefix) and this chapter's research
 * package. Drafts on Sonnet — far faster token generation than Opus.
 *
 * A single Sonnet pass under-writes long chapters, so a too-short draft (below
 * EXPAND_THRESHOLD of its word target) gets one Sonnet expansion pass that
 * deepens it to full length — reliably reaching the book's target page count
 * while keeping the fast model. The Phase 12 polish pass recovers quality.
 * Idempotent on inputHash.
 */
export class GenerateChapterUseCase {
  constructor(
    private readonly books: BookRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly ai: AiTextGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(cmd: ChapterJob): Promise<Result<{ skipped: boolean }>> {
    const projectId = ProjectId.from(cmd.projectId);
    const book = await this.books.findByProject(projectId);
    if (!book) return Result.fail('Book not found');
    const chapter = book.chapter(ChapterId.from(cmd.chapterId));
    if (!chapter) return Result.fail('Chapter not found');
    if (chapter.isGeneratedFor(cmd.inputHash)) return Result.ok({ skipped: true }); // idempotent

    const ctx = await this.books.loadSharedContext(projectId);
    const research = await this.knowledge.getChapterResearch(chapter.id);
    const researchText = research?.toText() ?? 'No additional research available; rely on the knowledge base.';
    chapter.markGenerating();

    // Cooking books: generate ONE structured recipe as JSON (not prose). The recipe
    // description + cuisine were carried on the chapter's keyPoints by the outline step.
    if (ctx.bookType === 'cooking') {
      return this.generateRecipe({ cmd, book, chapter, ctx });
    }

    // The shared, cacheable system prefix (book strategy + KB) — identical for the
    // draft and the expand pass, so the second call reads it from cache.
    const system = ChapterPrompt.system({
      bookStrategy: ctx.bookStrategy,
      knowledgeBase: ctx.knowledgeBase,
      tone: ctx.tone,
      authorVoice: ctx.authorVoice,
      // The user's title governs the chapter's subject matter, not the channel's usual topic.
      bookTitle: ctx.bookTitle ?? book.title ?? undefined,
    });

    const completion = await this.ai.generate({
      model: 'claude-sonnet-4-6',
      system,
      messages: [
        {
          role: 'user',
          content: ChapterPrompt.user({
            title: chapter.title,
            purpose: chapter.topic,
            promise: chapter.promise,
            wordTarget: chapter.wordTarget,
            research: researchText,
            ...(cmd.instructions ? { instructions: cmd.instructions } : {}),
          }),
        },
      ],
      // ~100-page book ⇒ ~3,200 words/chapter. 8000 tokens (~6k words) can truncate
      // a long chapter once the "write the full length" instruction is honored.
      maxTokens: 12000,
      cacheControl: { systemPrefix: true },
      metadata: { projectId: cmd.projectId, stage: 'chapter-generate' },
    });
    if (completion.isFail()) return Result.fail(completion.error.type);

    // Second-pass expansion: a Sonnet draft routinely lands short of a 3,000+ word
    // target. If so, run ONE expand pass that deepens the draft to full length —
    // models expand a scaffold far more reliably than they hit a high count cold.
    let content = completion.value.text;
    const draftWords = countWords(content);
    if (draftWords < chapter.wordTarget * EXPAND_THRESHOLD) {
      const expanded = await this.ai.generate({
        model: 'claude-sonnet-4-6',
        system,
        messages: [
          {
            role: 'user',
            content: ChapterPrompt.expand({
              title: chapter.title,
              draft: content,
              currentWords: draftWords,
              targetWords: chapter.wordTarget,
              research: researchText,
            }),
          },
        ],
        maxTokens: 12000,
        cacheControl: { systemPrefix: true },
        metadata: { projectId: cmd.projectId, stage: 'chapter-expand' },
      });
      // Keep the expansion only if it actually grew the chapter; otherwise the
      // draft stands. Never let a failed/shorter expand pass lose the draft.
      if (expanded.isOk() && countWords(expanded.value.text) > draftWords) {
        content = expanded.value.text;
      }
    }

    if (cmd.mode === 'regenerate') {
      await this.books.snapshotChapterVersion(book.id, chapter.id.value);
    }
    const applied = book.regenerateChapter(
      chapter.id,
      { content, inputHash: cmd.inputHash },
      this.clock.now(),
    );
    if (applied.isFail()) return Result.fail(applied.error);
    // Persist ONLY this chapter. A full save(book) re-upserts every chapter, so
    // parallel chapter jobs would clobber each other's just-written content with
    // their own stale snapshot — leaving a chapter PENDING and breaking assembly.
    await this.books.saveChapter(book.id, chapter);
    return Result.ok({ skipped: false });
  }

  /**
   * Generate one recipe as structured JSON and store it (serialized) as the
   * chapter content. No expand pass — recipe length is governed by the prompt.
   * A malformed-JSON completion is retried once before failing.
   */
  private async generateRecipe(input: {
    cmd: ChapterJob;
    book: Book;
    chapter: Chapter;
    ctx: SharedChapterContext;
  }): Promise<Result<{ skipped: boolean }>> {
    const { cmd, book, chapter, ctx } = input;
    // keyPoints = [description, cuisine] from the recipe-outline step.
    const description = chapter.keyPoints[0] ?? chapter.topic ?? '';
    const cuisine = chapter.keyPoints[1] ?? '';

    const system = RecipePrompt.system({
      bookStrategy: ctx.bookStrategy,
      knowledgeBase: ctx.knowledgeBase,
      cuisine,
    });
    const userMsg = RecipePrompt.user({ title: chapter.title, description });

    let content: string | null = null;
    let lastError = '';
    for (let attempt = 0; attempt < 2 && content === null; attempt++) {
      const completion = await this.ai.generate({
        model: 'claude-sonnet-4-6',
        system,
        messages: [{ role: 'user', content: userMsg }],
        // A full recipe (title + description + ~14 ingredients + 4-7 labelled steps
        // + tips) can exceed a tight ceiling and truncate mid-JSON, which fails to
        // parse and renders as a blank card. 8000 gives ample headroom; billed on
        // actual output, so the extra ceiling costs nothing on normal recipes.
        maxTokens: 8000,
        cacheControl: { systemPrefix: true },
        metadata: { projectId: cmd.projectId, stage: 'chapter-generate' },
      });
      if (completion.isFail()) return Result.fail(completion.error.type);
      const parsed = parseJsonCompletion(completion.value.text, RecipeSchema);
      if (parsed.isOk()) content = serializeRecipe(parsed.value);
      else lastError = parsed.error;
    }
    // Fail LOUD rather than shipping a DONE chapter whose content can't be parsed
    // into a recipe (that renders as a blank card). A failed chapter blocks assembly
    // and surfaces in retry, which is the correct, visible outcome.
    if (content === null) return Result.fail(`Recipe JSON malformed after retry: ${lastError}`);

    if (cmd.mode === 'regenerate') {
      await this.books.snapshotChapterVersion(book.id, chapter.id.value);
    }
    const applied = book.regenerateChapter(chapter.id, { content, inputHash: cmd.inputHash }, this.clock.now());
    if (applied.isFail()) return Result.fail(applied.error);
    await this.books.saveChapter(book.id, chapter);
    return Result.ok({ skipped: false });
  }
}

/** Whitespace-delimited word count — good enough to gate the expansion pass. */
function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
