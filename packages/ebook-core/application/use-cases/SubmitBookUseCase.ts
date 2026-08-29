import { Result } from '../../domain/shared/Result';
import { Project } from '../../domain/project/Project';
import { ProjectId } from '../../domain/project/ProjectId';
import { GenerationOptions } from '../../domain/project/GenerationOptions';
import { ReferenceBookId } from '../../domain/reference/ReferenceBookId';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { ReferenceBookRepository } from '../ports/repositories/ReferenceBookRepository';
import type { JobQueue } from '../ports/services/JobQueue';
import type { IdGenerator } from '../ports/IdGenerator';
import type { Clock } from '../ports/Clock';
import type { SubmitBookDto } from '../dto/SubmitBook.dto';
import { titleCarriesSubject } from './GenerateBookBriefUseCase';

export interface SubmitBookResult {
  projectId: string;
  status: string;
  /** True when the book was accepted but parked in QUEUED awaiting a free slot. */
  queued: boolean;
  /** How many of the user's books are already waiting ahead of this one. */
  queuePosition: number;
  /**
   * Set when the primary reference's own shape disagrees with the book type —
   * a cookbook chosen as the reference for a prose book, or the reverse. Not an
   * error: the voice still transfers, but the structural half of the profile is
   * discarded, so the caller should say so rather than let it pass silently.
   */
  referenceTypeMismatch?: string;
}

/**
 * Entry point: creates a book project from a TITLE and one or more REFERENCE
 * BOOKS, then either starts it or parks it in QUEUED.
 *
 * Replaces SubmitChannelUseCase. The admission behaviour is deliberately
 * identical — a user may submit any number of books, at most `maxActiveProjects`
 * RUN at once, nothing is ever rejected for being over the limit — because that
 * had nothing to do with where the material came from.
 *
 * What IS new is validation. The old entry point could accept a thin request
 * and let ingestion discover the problem, because ingestion read a real channel
 * and would fail loudly against it. Here there is no such second source: a bad
 * title or an unusable reference produces a plausible-looking book made of
 * nothing, and the only place that becomes visible is the finished manuscript.
 * So both are checked at submit, while a person is still looking at the screen.
 */
export class SubmitBookUseCase {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly references: ReferenceBookRepository,
    private readonly queue: JobQueue,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly maxActiveProjects: number = 3,
  ) {}

  async execute(ownerId: string, dto: SubmitBookDto): Promise<Result<SubmitBookResult>> {
    const options = GenerationOptions.create(dto.options);
    const title = options.bookTitle?.trim() ?? '';
    if (title.length === 0) return Result.fail('A book needs a title — the title is its subject');
    if (!titleCarriesSubject(title)) {
      return Result.fail(
        `"${title}" names a format but not a subject. The title is the only thing that says what this ` +
          'book is about, so it needs one — "Sourdough for Beginners" rather than "Recipes".',
      );
    }

    // Load every chosen reference before creating anything: a project that
    // exists but can never run is worse than a rejected submit.
    const ids = dto.referenceBookIds.map((id) => ReferenceBookId.from(id));
    const loaded = await Promise.all(ids.map((id) => this.references.findById(id)));
    for (const [index, reference] of loaded.entries()) {
      if (!reference) return Result.fail(`Reference book ${dto.referenceBookIds[index]} was not found`);
      if (reference.ownerId !== ownerId) {
        // Same answer as not-found, deliberately: whether someone else's
        // reference exists is not this caller's business.
        return Result.fail(`Reference book ${dto.referenceBookIds[index]} was not found`);
      }
      if (!reference.isUsable()) {
        return Result.fail(
          `"${reference.title}" is not ready to be used as a reference` +
            (reference.error ? `: ${reference.error}` : ' — its text is still being extracted.'),
        );
      }
    }

    const primary = loaded[0]!;
    const bookType = options.isCooking ? ('cooking' as const) : ('normal' as const);
    // Advisory only — see SubmitBookResult.referenceTypeMismatch.
    const mismatch =
      primary.styleProfile && !primary.styleProfile.matches(bookType)
        ? `"${primary.title}" reads as a ${primary.styleProfile.detectedKind} book, but this is a ` +
          `${bookType} book. Its voice will carry over; its structure will not.`
        : undefined;

    // Soft cap: two simultaneous submits can both read the same count, which at
    // worst starts one book more than the limit. Worth avoiding a lock for.
    const running = await this.projects.countRunningByOwner(ownerId);
    const startNow = running < this.maxActiveProjects;
    // Only needed for the "you're Nth in line" message when we're not starting.
    const waiting = startNow ? [] : await this.projects.listQueuedByOwner(ownerId);

    const id = ProjectId.from(this.ids.uuid());
    const project = Project.create({ id, ownerId, options, now: this.clock.now() });
    if (project.isFail()) return Result.fail(project.error);

    const advance = project.value.advanceTo(startNow ? 'GENERATING_BOOK_BRIEF' : 'QUEUED', this.clock.now());
    if (advance.isFail()) return Result.fail(advance.error);

    // Persist BEFORE enqueuing: the worker loads the project by id, so the row
    // has to exist by the time the job is picked up. The references are attached
    // in the same order they were chosen — the first is the book's voice.
    await this.projects.save(project.value);
    await this.references.attachToProject(id, ids);
    if (startNow) {
      await this.queue.enqueue('book-brief', { projectId: id.value }, { jobId: `book-brief:${id.value}` });
    }

    return Result.ok({
      projectId: id.value,
      status: project.value.status.value,
      queued: !startNow,
      queuePosition: startNow ? 0 : waiting.length + 1,
      ...(mismatch ? { referenceTypeMismatch: mismatch } : {}),
    });
  }
}
