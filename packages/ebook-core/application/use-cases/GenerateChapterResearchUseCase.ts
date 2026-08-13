import { z } from 'zod';
import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { ChapterId } from '../../domain/book/ids';
import { ChapterResearch } from '../../domain/book/ChapterResearch';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { VideoRepository } from '../ports/repositories/VideoRepository';
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

const TOP_VIDEOS_PER_CHAPTER = 8;

/**
 * Phase 10: assemble a chapter research package WITHOUT a vector DB. Relevant
 * videos are retrieved by keyword/theme overlap between the chapter and each
 * video's summary+themes, then Sonnet organizes the material into the package.
 */
export class GenerateChapterResearchUseCase {
  constructor(
    private readonly books: BookRepository,
    private readonly videos: VideoRepository,
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

    // Titles + summaries only. Ranking never reads transcripts or comments, and
    // this runs once per chapter across concurrent books — pulling the whole
    // corpus per call is what exhausted the database's statement timeout.
    const videos = await this.videos.findSummarizedByProject(projectId);
    const terms = tokenize([chapter.title, chapter.topic, chapter.promise, ...chapter.keyPoints].join(' '));

    // Rank videos by keyword overlap with the chapter (the "retrieval" step).
    const ranked = videos
      .map((v) => {
        const haystack = tokenize(`${v.title} ${v.summary.searchableText()}`);
        return { v, score: overlap(terms, haystack) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_VIDEOS_PER_CHAPTER);

    const candidateMaterial = ranked
      .map(({ v }) => `Video: ${v.title}\n${v.summary.toText()}`)
      .join('\n\n');

    const audienceQuestions = (await this.knowledge.listCommentInsights(projectId))
      .flatMap((i) => i.commonQuestions)
      .slice(0, 20);

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
        relatedVideoIds: ranked.map(({ v }) => v.id),
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
