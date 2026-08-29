import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { JobQueue, QueueName } from '../ports/services/JobQueue';
import type { Clock } from '../ports/Clock';
import type { Logger } from '../ports/Logger';
import { ProjectId } from '../../domain/project/ProjectId';
import type { ProjectState } from '../../domain/project/ProjectStatus';

/**
 * The single component allowed to advance the project state machine and enqueue
 * the next pipeline stage. Fan-in barriers are implemented with the atomic
 * decrementPending counter — no distributed locks.
 */
export class PipelineOrchestrator {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    private readonly logger: Logger,
    /** Optional: starts the owner's next QUEUED book when this one completes. */
    private readonly admission?: { promoteAfter(projectId: string): Promise<number> },
  ) {}

  /** Called by a fan-out child when it finishes; advances when the barrier hits zero. */
  async onStageItemCompleted(projectId: string, stage: ProjectState): Promise<void> {
    const remaining = await this.projects.decrementPending(ProjectId.from(projectId), stage);
    this.logger.debug('stage item completed', { projectId, stage, remaining });
    if (remaining <= 0) await this.advance(projectId, stage);
  }

  /**
   * Per-video fan-in convergence: jump from the per-video phase to `target`.
   *
   * Dozens of per-video jobs can finish near-simultaneously and all call this at
   * once. A prior racing advance may also have left the status anywhere within
   * the per-video phase. So we transition ATOMICALLY from any per-video status to
   * the target in one guarded write — exactly one caller wins and enqueues the
   * next stage; the rest no-op. This replaces the old read-walk-save, which lost
   * updates under that concurrency and could wedge the project mid-phase.
   */
  async reachStage(projectId: string, target: ProjectState): Promise<void> {
    const won = await this.projects.advanceStatusAtomic(ProjectId.from(projectId), PER_VIDEO_PHASE, target);
    if (won) {
      this.logger.info('per-video phase converged', { projectId, target });
      await this.enqueueStageEntry(projectId, target);
    }
  }

  /**
   * Retry a FAILED project. Re-queues every failed BullMQ job for the project and
   * rewinds the project status to the earliest failed stage so the barrier/advance
   * logic can move forward again once the replayed jobs succeed.
   */
  async resume(projectId: string): Promise<{ retried: number; stage?: ProjectState }> {
    const project = await this.projects.findById(ProjectId.from(projectId));
    if (!project) return { retried: 0 };
    if (project.status.value !== 'FAILED') return { retried: 0 };

    const failedQueues = await this.queue.failedStages(projectId);
    const stage = earliestStage(failedQueues);
    if (!stage) {
      this.logger.warn('resume: no failed jobs to retry', { projectId });
      return { retried: 0 };
    }

    // Rewind status BEFORE replaying so a fast-completing job can advance the barrier.
    const reset = project.resumeAt(stage, this.clock.now());
    if (reset.isFail()) {
      this.logger.warn('resume: could not rewind status', { projectId, stage, error: reset.error });
      return { retried: 0 };
    }
    await this.projects.save(project);

    const retried = await this.queue.retryFailed(projectId);
    this.logger.info('resume: retried failed jobs', { projectId, stage, retried });
    return { retried, stage };
  }

  /** Advance from a just-completed stage to the next, enqueuing its job(s). */
  async advance(projectId: string, completed: ProjectState): Promise<void> {
    const next = NEXT_STAGE[completed];
    if (!next) return;
    // Atomic compare-and-advance: only transition while status is still
    // `completed`. Idempotent under fan-in — concurrent completions can't
    // double-advance or clobber the status; the losers simply no-op.
    const won = await this.projects.advanceStatusAtomic(ProjectId.from(projectId), [completed], next);
    if (!won) {
      this.logger.debug('advance skipped — status already moved', { projectId, completed, next });
      return;
    }
    await this.enqueueStageEntry(projectId, next);
    // This book just released its concurrency slot — hand it to the owner's next
    // queued book. Only the winner of the atomic advance gets here, so a slot is
    // never handed out twice. Best-effort: a failure here must not fail the job.
    if (next === 'COMPLETED' && this.admission) {
      try {
        const started = await this.admission.promoteAfter(projectId);
        if (started > 0) this.logger.info('started queued project(s)', { after: projectId, started });
      } catch (err) {
        this.logger.warn('could not start queued projects', { after: projectId, error: String(err) });
      }
    }
  }

  /** Enqueue the entrypoint job for a stage (fan-out jobs are scheduled by the use case). */
  private async enqueueStageEntry(projectId: string, stage: ProjectState): Promise<void> {
    const queueName = STAGE_ENTRY_QUEUE[stage];
    if (!queueName) return; // fan-out stages enqueue their own children
    await this.queue.enqueue(queueName, { projectId }, { jobId: `${queueName}:${projectId}` });
  }
}

/**
 * The coarse statuses that make up the per-video fan-in phase. reachStage accepts
 * any of these as the source when converging to the knowledge-base stage.
 */
const PER_VIDEO_PHASE: ProjectState[] = [];

/** Linear stage progression (conditional branches & fan-outs resolved inside use cases). */
const NEXT_STAGE: Partial<Record<ProjectState, ProjectState>> = {  GENERATING_BOOK_STRATEGY: 'GENERATING_OUTLINE',
  GENERATING_OUTLINE: 'GENERATING_CHAPTER_RESEARCH',
  GENERATING_CHAPTER_RESEARCH: 'GENERATING_CHAPTERS',
  GENERATING_CHAPTERS: 'POLISHING_BOOK',
  POLISHING_BOOK: 'ASSEMBLING',
  ASSEMBLING: 'EXPORTING',
  EXPORTING: 'COMPLETED',
};

/**
 * Stages with a single controller entry job. Fan-out stages
 * (GENERATING_CHAPTER_RESEARCH, GENERATING_CHAPTERS) are intentionally absent —
 * their producer use cases set the barrier and enqueue the per-item jobs.
 */
const STAGE_ENTRY_QUEUE: Partial<Record<ProjectState, QueueName>> = {  GENERATING_BOOK_STRATEGY: 'book-strategy',
  GENERATING_OUTLINE: 'outline-generate',
  POLISHING_BOOK: 'polish-book',
  ASSEMBLING: 'ebook-assemble',
  EXPORTING: 'export',
};

/**
 * The stage each queue belongs to — used to rewind a FAILED project on retry.
 * Partial by design: post-pipeline side-car queues (landing-page) belong to no
 * stage, and a failure in one must never rewind a finished book. They are
 * filtered out where this map is read.
 */
const QUEUE_TO_STAGE: Partial<Record<QueueName, ProjectState>> = {  'book-strategy': 'GENERATING_BOOK_STRATEGY',
  'outline-generate': 'GENERATING_OUTLINE',
  'chapter-research': 'GENERATING_CHAPTER_RESEARCH',
  'chapter-generate': 'GENERATING_CHAPTERS',
  'polish-book': 'POLISHING_BOOK',
  'polish-chapter': 'POLISHING_BOOK',
  'extra-content': 'GENERATING_CHAPTERS', // user-triggered; rewind alongside chapters
  'ebook-assemble': 'ASSEMBLING',
  export: 'EXPORTING',
};

/** Linear order of pipeline stages, for picking the earliest among several failures. */
const STAGE_ORDER: ProjectState[] = [
  'CREATED',  'GENERATING_BOOK_STRATEGY',
  'GENERATING_OUTLINE',
  'GENERATING_CHAPTER_RESEARCH',
  'GENERATING_CHAPTERS',
  'POLISHING_BOOK',
  'ASSEMBLING',
  'EXPORTING',
  'COMPLETED',
];

/** Map failed queues to their stages and return the earliest one in pipeline order. */
function earliestStage(queues: QueueName[]): ProjectState | undefined {
  const stages = queues.map((q) => QUEUE_TO_STAGE[q]).filter((s): s is ProjectState => Boolean(s));
  if (stages.length === 0) return undefined;
  return stages.reduce((earliest, s) => (STAGE_ORDER.indexOf(s) < STAGE_ORDER.indexOf(earliest) ? s : earliest));
}
