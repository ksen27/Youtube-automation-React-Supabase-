import { z } from 'zod';
import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { ChannelKnowledgeBase } from '../../domain/channel/ChannelKnowledgeBase';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { KnowledgeRepository } from '../ports/repositories/KnowledgeRepository';
import type { ReferenceBookRepository } from '../ports/repositories/ReferenceBookRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { Hasher } from '../ports/Hasher';
import type { ProjectJob } from '../dto/jobs.dto';
import { BookBriefPrompt } from '../prompts/BookBriefPrompt';
import { parseJsonCompletion } from '../prompts/parse';

/**
 * Claude occasionally returns a list field as a single string. Coerce rather
 * than fail the stage over a shape drift — inherited from the knowledge-base
 * builder this replaces, where it was a real and recurring failure.
 */
const stringArray = z.preprocess(
  (v) => (typeof v === 'string' ? [v] : v == null ? [] : v),
  z.array(z.string()),
);

const Schema = z.object({
  coreThemes: stringArray,
  corePrinciples: stringArray,
  recurringAdvice: stringArray,
  commonMistakes: stringArray,
  audiencePainPoints: stringArray,
  audienceGoals: stringArray,
  transformationJourney: z.string(),
  expertPositioning: z.string(),
  hiddenInsights: stringArray,
});

/**
 * Words that name a FORMAT rather than a subject. A title made only of these
 * says what the artifact is, not what it is about.
 */
const FORMAT_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'my', 'your', 'complete', 'ultimate', 'essential',
  'book', 'books', 'ebook', 'guide', 'handbook', 'manual', 'cookbook', 'recipes', 'recipe', 'edition',
  'volume', 'new', 'best', 'top', 'beginners', 'beginner', 'advanced', 'introduction', 'basics',
]);

/**
 * Whether a title carries a subject at all.
 *
 * "Recipes" and "My Complete Guide" are titles; neither says what the book is
 * about, and with the channel gone there is no second source that could make up
 * the difference. Generating from one produces a hundred well-voiced pages
 * about nothing — a failure that only becomes visible in the finished
 * manuscript, which is the most expensive place to discover it.
 */
export function titleCarriesSubject(title: string): boolean {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    // A leading count ("100 Keto Dinners") is scope, not subject.
    .filter((w) => !/^\d+$/.test(w));
  return words.some((w) => !FORMAT_WORDS.has(w));
}

/**
 * Builds the knowledge base a book is written from, out of its TITLE.
 *
 * The pipeline's entry stage, and the seam the channel pipeline used to fill.
 * Everything downstream — strategy, outline, research, chapters — reads the
 * knowledge base and is unchanged.
 *
 * Three inputs, cleanly separated: the TITLE is the subject, the BOOK TYPE is
 * the shape, and the reference book's style profile is the voice. Only the
 * first two are required — a book with no reference still generates, just in a
 * default voice.
 */
export class GenerateBookBriefUseCase {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly references: ReferenceBookRepository,
    private readonly ai: AiTextGenerator,
    private readonly hasher: Hasher,
  ) {}

  async execute(cmd: ProjectJob): Promise<Result<void>> {
    const projectId = ProjectId.from(cmd.projectId);
    const project = await this.projects.findById(projectId);
    if (!project) return Result.fail('Project not found');

    const title = project.options.bookTitle?.trim() ?? '';
    if (title.length === 0) return Result.fail('This book has no title, and the title is its subject');
    if (!titleCarriesSubject(title)) {
      return Result.fail(
        `"${title}" names a format but no subject. With no channel to draw material from, the title is ` +
          'the only thing that says what this book is about — give it one (e.g. "Sourdough for Beginners" ' +
          'rather than "Recipes").',
      );
    }

    // The primary reference is the first one chosen; its voice is the book's.
    // Later references contribute material through chapter research, not voice —
    // blending two voices produces neither.
    const referenceBooks = await this.references.findByProject(projectId);
    const primary = referenceBooks[0];
    const styleProfile = primary?.styleProfile ?? null;

    const bookType = project.options.isCooking ? ('cooking' as const) : ('normal' as const);
    const inputHash = this.hasher.hash({
      title,
      bookType,
      tone: project.options.tone,
      pages: project.options.targetPages,
      style: styleProfile?.inputHash ?? null,
    });
    const existing = await this.knowledge.getKnowledgeBase(projectId);
    if (existing?.inputHash === inputHash) return Result.ok(); // idempotent

    const completion = await this.ai.generate({
      model: 'claude-sonnet-4-6',
      system: BookBriefPrompt.system({
        bookType,
        styleProfile: styleProfile?.toPromptText() ?? null,
        tone: project.options.tone,
      }),
      messages: [
        {
          role: 'user',
          content: BookBriefPrompt.user({ title, targetPages: project.options.targetPages }),
        },
      ],
      // Nine fields, seven of them arrays of 5-10 full sentences. The builder
      // this replaces truncated mid-object at 2500 and failed JSON parsing.
      maxTokens: 8000,
      cacheControl: { systemPrefix: true },
      metadata: { projectId: cmd.projectId, stage: 'book-brief' },
    });
    if (completion.isFail()) return Result.fail(completion.error.type);

    const parsed = parseJsonCompletion(completion.value.text, Schema);
    if (parsed.isFail()) return Result.fail(parsed.error);

    await this.knowledge.saveKnowledgeBase(projectId, ChannelKnowledgeBase.create({ ...parsed.value, inputHash }));
    return Result.ok();
  }
}
