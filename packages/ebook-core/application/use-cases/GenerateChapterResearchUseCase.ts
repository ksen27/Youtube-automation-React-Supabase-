import { z } from 'zod';
import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { ChapterId } from '../../domain/book/ids';
import { ChapterResearch } from '../../domain/book/ChapterResearch';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { KnowledgeRepository } from '../ports/repositories/KnowledgeRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { ChapterResearchJob } from '../dto/jobs.dto';
import { ChapterResearchPrompt } from '../prompts/ChapterResearchPrompt';
import { parseJsonCompletion } from '../prompts/parse';

const Schema = z.object({
  supportingStories: z.array(z.string()),
  supportingLessons: z.array(z.string()),
  supportingExamples: z.array(z.string()),
  supportingCaseStudies: z.array(z.string()),
  supportingFrameworks: z.array(z.string()),
  supportingPrinciples: z.array(z.string()),
});

/** How many knowledge-base passages one chapter is researched from. */
const TOP_PASSAGES_PER_CHAPTER = 12;

/**
 * Phase 10: assemble a chapter research package WITHOUT a vector DB.
 *
 * Retrieval used to rank the project's VIDEOS by keyword overlap with the
 * chapter. With the channel pipeline gone there are no videos: the corpus is
 * the project's knowledge base, and the same overlap ranking picks the passages
 * within it this chapter should be built from. Same shape, same cost, different
 * source — which is why the knowledge base was worth keeping as the seam.
 */
export class GenerateChapterResearchUseCase {
  constructor(
    private readonly books: BookRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly ai: AiTextGenerator,
  ) {}

  async execute(cmd: ChapterResearchJob): Promise<Result<void>> {
    const projectId = ProjectId.from(cmd.projectId);
    const chapterId = ChapterId.from(cmd.chapterId);

    const existing = await this.knowledge.getChapterResearch(chapterId);
    if (existing?.inputHash === cmd.inputHash) return Result.ok(); // idempotent

    const book = await this.books.findByProject(projectId);
    const chapter = book?.chapter(chapterId);
    if (!book || !chapter) return Result.fail('Chapter not found');

    // The knowledge base is the corpus. Its fields are already the distilled
    // material a chapter wants — themes, principles, advice, mistakes — so each
    // entry is treated as one retrievable passage.
    const kb = await this.knowledge.getKnowledgeBase(projectId);
    if (!kb) return Result.fail('No knowledge base for this project');
    const terms = tokenize([chapter.title, chapter.topic, chapter.promise, ...chapter.keyPoints].join(' '));

    const passages = [
      ...kb.coreThemes.map((t) => `Theme: ${t}`),
      ...kb.corePrinciples.map((t) => `Principle: ${t}`),
      ...kb.audiencePainPoints.map((t) => `Reader problem: ${t}`),
      ...kb.audienceGoals.map((t) => `Reader goal: ${t}`),
    ];

    // Rank passages by keyword overlap with the chapter (the retrieval step).
    // A zero-overlap passage is dropped rather than padded in: a chapter is
    // better served by four relevant passages than by twelve where eight are
    // about a different part of the book.
    const ranked = passages
      .map((text) => ({ text, score: overlap(terms, tokenize(text)) }))
      .filter((p) => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_PASSAGES_PER_CHAPTER);

    // Nothing overlapped — an early chapter phrased in words the knowledge base
    // does not use. Falling back to the whole base beats researching a chapter
    // from nothing.
    const candidateMaterial = (ranked.length > 0 ? ranked.map((p) => p.text) : passages).join('\n');

    const audienceQuestions = kb.audiencePainPoints.slice(0, 20);

    const prompt = ChapterResearchPrompt.build({
      chapterTitle: chapter.title,
      chapterPurpose: chapter.topic,
      keyPoints: chapter.keyPoints,
      candidateMaterial: `${candidateMaterial}\n\nAudience questions:\n${audienceQuestions.join('\n')}`,
      // Keeps retrieval from dragging in adjacent channel topics that fit the channel but not the book.
      ...(book.title ? { bookTitle: book.title } : {}),
    });
    const completion = await this.ai.generate({
      model: 'claude-sonnet-4-6',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      // Six supporting arrays (stories, lessons, examples, case studies,
      // frameworks, principles) overflow 2500 and truncate the JSON.
      maxTokens: 6000,
      // Shared system block → cache read on every per-chapter research call.
      cacheControl: { systemPrefix: true },
      metadata: { projectId: cmd.projectId, stage: 'chapter-research' },
    });
    if (completion.isFail()) return Result.fail(completion.error.type);

    const parsed = parseJsonCompletion(completion.value.text, Schema);
    if (parsed.isFail()) return Result.fail(parsed.error);

    await this.knowledge.saveChapterResearch(
      projectId,
      ChapterResearch.create({
        chapterId: cmd.chapterId,
        chapterTitle: chapter.title,
        // No videos any more; the field stays on the record for stored history.
        relatedVideoIds: [],
        audienceQuestions,
        inputHash: cmd.inputHash,
        ...parsed.value,
      }),
    );
    return Result.ok();
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const term of a) if (b.has(term)) count++;
  return count;
}
