import { z } from 'zod';
import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { Book } from '../../domain/book/Book';
import { BookId, ChapterId } from '../../domain/book/ids';
import { Outline, type OutlineEntry } from '../../domain/book/Outline';
import { Chapter } from '../../domain/book/Chapter';
import { PageBudget } from '../../domain/book/PageBudget';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { KnowledgeRepository } from '../ports/repositories/KnowledgeRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { JobQueue } from '../ports/services/JobQueue';
import type { IdGenerator } from '../ports/IdGenerator';
import type { Clock } from '../ports/Clock';
import type { Hasher } from '../ports/Hasher';
import { OutlinePrompt } from '../prompts/OutlinePrompt';
import { RecipeOutlinePrompt } from '../prompts/RecipeOutlinePrompt';
import { RecipeIdeaSchema, type RecipeIdea } from '../../domain/book/Recipe';
import { parseJsonCompletion } from '../prompts/parse';
import type { ProjectJob } from '../dto/jobs.dto';

const Schema = z.object({
  title: z.string(),
  entries: z.array(
    z.object({
      title: z.string(),
      purpose: z.string(),
      promise: z.string(),
      keyPoints: z.array(z.string()),
      wordTarget: z.number(),
    }),
  ),
});

const RecipeIdeasSchema = z.object({ recipes: z.array(RecipeIdeaSchema) });

/** Recipes are requested in batches so a large count doesn't overflow one JSON completion. */
const RECIPE_BATCH_SIZE = 25;

/**
 * Phase 9 (Sonnet): generate the outline from strategy + knowledge base,
 * materialize chapters, then fan out one chapter-research job per chapter
 * (the producer owns the GENERATING_CHAPTER_RESEARCH barrier).
 */
export class GenerateOutlineUseCase {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly books: BookRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly ai: AiTextGenerator,
    private readonly queue: JobQueue,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly hasher: Hasher,
  ) {}

  async execute(cmd: ProjectJob): Promise<Result<void>> {
    const projectId = ProjectId.from(cmd.projectId);
    const project = await this.projects.findById(projectId);
    if (!project) return Result.fail('Project not found');
    const strategy = await this.knowledge.getBookStrategy(projectId);
    const kb = await this.knowledge.getKnowledgeBase(projectId);
    if (!strategy || !kb) return Result.fail('Book strategy or knowledge base missing');

    const budget = PageBudget.of(project.options.targetPages);
    // Chapter count is DETERMINISTIC from the page budget — NOT strategy.chapterCount,
    // which the model tends to return low (2–3), producing tiny books regardless of
    // the page target. ~targetPages/7 → 14 chapters for a 100-page book; clamped 2–14.
    const chapterCount = Math.max(2, Math.min(14, Math.round(project.options.targetPages / 7)));
    // bookTitle is part of the hash so retitling a project rebuilds the outline
    // instead of reusing chapters written for the previous title.
    const inputHash = this.hasher.hash({
      strat: strategy.inputHash,
      kb: kb.inputHash,
      title: project.options.bookTitle ?? '',
    });

    let book = await this.books.findByProject(projectId);
    if (!book?.outline || book.outline.inputHash !== inputHash) {
      // Cooking books: the "outline" is a list of AI-suggested recipes; each recipe
      // becomes one chapter whose body is generated as structured recipe JSON.
      const entries = project.options.isCooking
        ? await this.buildRecipeEntries({ strategy, kb, recipeCount: project.options.recipeCount, projectId: cmd.projectId })
        : await this.buildChapterEntries({
            strategy,
            kb,
            chapterCount,
            perChapterWords: budget.perChapterWords(chapterCount),
            projectId: cmd.projectId,
            bookTitle: project.options.bookTitle,
          });
      if (entries.isFail()) return Result.fail(entries.error);

      book = book ?? Book.create({ id: BookId.from(this.ids.uuid()), projectId: projectId.value, targetPages: project.options.targetPages });
      // Prefer the user-provided title; fall back to the AI-generated strategy title.
      book.setTitle(project.options.bookTitle ?? strategy.title);
      book.setOutline(Outline.create({ version: 1, entries: entries.value, inputHash }));
      // For prose books, derive the per-chapter word target deterministically from
      // the page budget and the ACTUAL number of chapters. For recipes the target
      // is a nominal value (recipe length is governed by the recipe prompt).
      const perChapterWords = project.options.isCooking ? 250 : budget.perChapterWords(entries.value.length);
      // Materialize chapters from the outline (Phase 9 → chapters / recipes).
      entries.value.forEach((entry, index) => {
        book!.addChapter(
          Chapter.create({
            id: ChapterId.from(this.ids.uuid()),
            bookId: book!.id.value,
            position: index,
            title: entry.title,
            topic: entry.purpose,
            promise: entry.promise,
            keyPoints: entry.keyPoints,
            wordTarget: perChapterWords,
          }),
        );
      });
      await this.books.save(book);
    }

    // Fan out chapter research and own the GENERATING_CHAPTER_RESEARCH barrier.
    project.setPending('GENERATING_CHAPTER_RESEARCH', book.chapters.length);
    project.advanceTo('GENERATING_CHAPTER_RESEARCH', this.clock.now());
    await this.projects.save(project);

    for (const chapter of book.chapters) {
      await this.queue.enqueue(
        'chapter-research',
        { projectId: projectId.value, chapterId: chapter.id.value, inputHash },
        { jobId: `chapter-research:${projectId.value}:${chapter.id.value}:${inputHash}` },
      );
    }
    return Result.ok();
  }

  /** Prose books: one Sonnet call → the chapter outline. */
  private async buildChapterEntries(input: {
    strategy: { toText(): string; tone: string };
    kb: { toText(): string };
    chapterCount: number;
    perChapterWords: number;
    projectId: string;
    bookTitle?: string | undefined;
  }): Promise<Result<OutlineEntry[]>> {
    const prompt = OutlinePrompt.build({
      bookStrategy: input.strategy.toText(),
      knowledgeBase: input.kb.toText(),
      chapterCount: input.chapterCount,
      perChapterWords: input.perChapterWords,
      tone: input.strategy.tone,
      bookTitle: input.bookTitle,
    });
    const completion = await this.ai.generate({
      model: 'claude-sonnet-4-6',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      // Up to 14 chapter entries (title/purpose/promise/keyPoints/wordTarget each)
      // can overflow and truncate the JSON mid-array. Ceiling only, billed on actual
      // output, so the headroom is free insurance.
      maxTokens: 16000,
      cacheControl: { systemPrefix: true },
      metadata: { projectId: input.projectId, stage: 'outline-generate' },
    });
    if (completion.isFail()) return Result.fail(completion.error.type);
    const parsed = parseJsonCompletion(completion.value.text, Schema);
    if (parsed.isFail()) return Result.fail(parsed.error);
    return Result.ok(parsed.value.entries);
  }

  /**
   * Cooking books: ask the model for `recipeCount` distinct recipes, in batches so
   * a large count can't truncate one JSON completion. Each recipe idea becomes a
   * chapter entry; `keyPoints` carries the recipe description + cuisine so the
   * chapter step can generate the recipe without re-deriving them.
   */
  private async buildRecipeEntries(input: {
    strategy: { toText(): string };
    kb: { toText(): string };
    recipeCount: number;
    projectId: string;
  }): Promise<Result<OutlineEntry[]>> {
    const ideas: RecipeIdea[] = [];
    const seen = new Set<string>();
    // Bounded retries: batches occasionally return fewer than asked or all-dupes.
    // Stop early once a batch adds nothing new so we never spin to the agent cap.
    const maxBatches = Math.ceil(input.recipeCount / RECIPE_BATCH_SIZE) + 3;
    for (let batch = 0; batch < maxBatches && ideas.length < input.recipeCount; batch++) {
      const need = Math.min(RECIPE_BATCH_SIZE, input.recipeCount - ideas.length);
      const prompt = RecipeOutlinePrompt.build({
        bookStrategy: input.strategy.toText(),
        knowledgeBase: input.kb.toText(),
        recipeCount: need,
        existingTitles: ideas.map((i) => i.title),
      });
      const completion = await this.ai.generate({
        model: 'claude-sonnet-4-6',
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        maxTokens: 8000,
        cacheControl: { systemPrefix: true },
        metadata: { projectId: input.projectId, stage: 'outline-generate' },
      });
      if (completion.isFail()) {
        if (ideas.length > 0) break; // keep what we have rather than fail the book
        return Result.fail(completion.error.type);
      }
      const parsed = parseJsonCompletion(completion.value.text, RecipeIdeasSchema);
      if (parsed.isFail()) {
        if (ideas.length > 0) break;
        return Result.fail(parsed.error);
      }
      let added = 0;
      for (const r of parsed.value.recipes) {
        const key = r.title.trim().toLowerCase();
        if (key && !seen.has(key)) {
          seen.add(key);
          ideas.push(r);
          added++;
          if (ideas.length >= input.recipeCount) break;
        }
      }
      if (added === 0) break; // batch produced only duplicates — stop
    }
    if (ideas.length === 0) return Result.fail('No recipes generated');

    return Result.ok(
      ideas.map((idea) => ({
        title: idea.title,
        purpose: idea.description,
        promise: idea.description,
        keyPoints: [idea.description, idea.cuisine].filter(Boolean),
        wordTarget: 250,
      })),
    );
  }
}
