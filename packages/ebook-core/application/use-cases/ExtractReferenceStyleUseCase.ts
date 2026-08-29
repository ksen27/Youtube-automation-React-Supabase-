import { z } from 'zod';
import { Result } from '../../domain/shared/Result';
import { ReferenceBookId } from '../../domain/reference/ReferenceBookId';
import { ReferenceStyleProfile } from '../../domain/reference/ReferenceStyleProfile';
import type { ReferenceBookRepository } from '../ports/repositories/ReferenceBookRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { Hasher } from '../ports/Hasher';
import type { ReferenceJob } from '../dto/jobs.dto';
import { ReferenceStylePrompt } from '../prompts/ReferenceStylePrompt';
import { parseJsonCompletion } from './../prompts/parse';

const Schema = z.object({
  voice: z.string(),
  readerAddress: z.string(),
  chapterShape: z.string(),
  openingMove: z.string(),
  closingMove: z.string(),
  pacing: z.string(),
  vocabulary: z.string(),
  recurringDevices: z.array(z.string()),
  avoid: z.array(z.string()),
  detectedKind: z.enum(['normal', 'cooking', 'other']),
});

/**
 * How many sections are sampled, and how much of each.
 *
 * A hundred-chapter book will not fit in one call and does not need to: voice is
 * visible in a few thousand words, and it is consistent by definition — a book
 * whose voice changes halfway is not a usable reference anyway. Sampling ACROSS
 * the book rather than taking the opening matters, because a first chapter is
 * the least representative part of most non-fiction: it is the part written to
 * sell the book.
 */
const SAMPLE_SECTIONS = 6;
const CHARS_PER_SECTION = 3000;

/** Evenly spaced picks across the book, always including the first and last. */
export function sampleSections<T>(sections: readonly T[], count = SAMPLE_SECTIONS): T[] {
  if (sections.length <= count) return [...sections];
  const step = (sections.length - 1) / (count - 1);
  const picked: T[] = [];
  for (let i = 0; i < count; i++) picked.push(sections[Math.round(i * step)]!);
  return picked;
}

/**
 * Extracts a reference book's style profile and caches it on the reference.
 *
 * Runs once per reference, not once per book: the reference never changes, and
 * every book generated from it reuses the answer.
 */
export class ExtractReferenceStyleUseCase {
  constructor(
    private readonly references: ReferenceBookRepository,
    private readonly ai: AiTextGenerator,
    private readonly hasher: Hasher,
  ) {}

  async execute(cmd: ReferenceJob): Promise<Result<{ outcome: 'extracted' | 'cached' }>> {
    const id = ReferenceBookId.from(cmd.referenceBookId);
    const reference = await this.references.findById(id);
    if (!reference) return Result.fail('Reference book not found');
    if (reference.sections.length === 0) {
      return Result.fail('Reference book has no text yet — extraction must run first');
    }

    const sampled = sampleSections(reference.sections);
    const excerpts = sampled
      .map((s) => `--- ${s.title ?? `Section ${s.position + 1}`} ---\n${s.content.slice(0, CHARS_PER_SECTION)}`)
      .join('\n\n');

    // Keyed on the sampled TEXT, not the reference id: re-running over unchanged
    // excerpts is a no-op rather than a second bill for the same answer.
    const inputHash = this.hasher.hash({ title: reference.title, excerpts });
    if (reference.styleProfile?.inputHash === inputHash) return Result.ok({ outcome: 'cached' });

    const completion = await this.ai.generate({
      model: 'claude-sonnet-4-6',
      system: ReferenceStylePrompt.system(),
      messages: [{ role: 'user', content: ReferenceStylePrompt.user({ title: reference.title, excerpts }) }],
      // Ten fields, two of them arrays of full sentences.
      maxTokens: 4000,
      cacheControl: { systemPrefix: true },
      metadata: { referenceBookId: cmd.referenceBookId, stage: 'reference-extract' },
    });
    if (completion.isFail()) return Result.fail(completion.error.type);

    const parsed = parseJsonCompletion(completion.value.text, Schema);
    if (parsed.isFail()) return Result.fail(parsed.error);

    reference.attachStyleProfile(ReferenceStyleProfile.create({ ...parsed.value, inputHash }));
    await this.references.save(reference);
    return Result.ok({ outcome: 'extracted' });
  }
}
