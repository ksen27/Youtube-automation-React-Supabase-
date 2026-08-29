import { ProjectId } from '../../domain/project/ProjectId';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { JobQueue } from '../ports/services/JobQueue';

/**
 * Admission controller for the per-user concurrency cap.
 *
 * Users may submit any number of books; SubmitChannelUseCase parks the ones over
 * the cap in QUEUED. This use case is what un-parks them: call it whenever a
 * project reaches a terminal state (completed, failed, cancelled) and it starts
 * as many of that user's queued books as there are now-free slots, oldest first.
 *
 * Safe under concurrency: the QUEUED → INGESTING_CHANNEL transition goes through
 * `advanceStatusAtomic`, so if two callers race (a completion and a cancellation
 * landing together) exactly one wins per project and only the winner enqueues the
 * ingest job. Two racing callers can each fill a slot they both saw as free, so
 * the cap is a soft limit that may briefly be exceeded by one — the same
 * trade-off SubmitChannelUseCase makes, and much cheaper than a distributed lock.
 */
export class StartQueuedProjectsUseCase {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly queue: JobQueue,
    private readonly maxActiveProjects: number = 3,
  ) {}

  /** Start as many of this owner's queued books as there is capacity for. */
  async promoteForOwner(ownerId: string): Promise<number> {
    const running = await this.projects.countRunningByOwner(ownerId);
    let slots = this.maxActiveProjects - running;
    if (slots <= 0) return 0;

    const queued = await this.projects.listQueuedByOwner(ownerId); // oldest first
    let started = 0;
    for (const candidate of queued) {
      if (slots <= 0) break;
      const id = ProjectId.from(candidate.id);
      const won = await this.projects.advanceStatusAtomic(id, ['QUEUED'], 'GENERATING_BOOK_STRATEGY');
      if (!won) continue; // another caller already claimed this one
      await this.queue.enqueue('book-strategy', { projectId: id.value }, { jobId: `channel-ingest:${id.value}` });
      slots -= 1;
      started += 1;
    }
    return started;
  }

  /**
   * Convenience for callers that only know the project that just finished —
   * resolves its owner, then promotes. A missing project is a no-op.
   */
  async promoteAfter(projectId: string): Promise<number> {
    const project = await this.projects.findById(ProjectId.from(projectId));
    if (!project) return 0;
    return this.promoteForOwner(project.ownerId);
  }
}
