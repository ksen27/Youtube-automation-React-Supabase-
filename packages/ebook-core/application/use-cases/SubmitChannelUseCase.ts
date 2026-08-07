import { Result } from '../../domain/shared/Result';
import { Project } from '../../domain/project/Project';
import { ProjectId } from '../../domain/project/ProjectId';
import { GenerationOptions } from '../../domain/project/GenerationOptions';
import { ChannelUrl } from '../../domain/channel/ChannelUrl';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { JobQueue } from '../ports/services/JobQueue';
import type { IdGenerator } from '../ports/IdGenerator';
import type { Clock } from '../ports/Clock';
import type { SubmitChannelDto } from '../dto/SubmitChannel.dto';

export interface SubmitChannelResult {
  projectId: string;
  status: string;
  /** True when the book was accepted but parked in QUEUED awaiting a free slot. */
  queued: boolean;
  /** How many of the user's books are already waiting ahead of this one. */
  queuePosition: number;
}

/**
 * Entry point: validates the channel URL, creates the project, and either starts
 * ingestion or parks the project in QUEUED.
 *
 * A user may submit any number of books. At most `maxActiveProjects` RUN at once
 * — the rest sit in QUEUED and are started automatically by
 * StartQueuedProjectsUseCase as running books reach a terminal state. Nothing is
 * ever rejected for being over the limit; the limit only controls how much runs
 * concurrently, so one account can't monopolise the workers or the AI rate limits.
 */
export class SubmitChannelUseCase {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly queue: JobQueue,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly maxActiveProjects: number = 3,
  ) {}

  async execute(ownerId: string, dto: SubmitChannelDto): Promise<Result<SubmitChannelResult>> {
    const url = ChannelUrl.create(dto.channelUrl);
    if (url.isFail()) return Result.fail(url.error);

    // Soft cap: two simultaneous submits can both read the same count, which at
    // worst starts one book more than the limit. Worth avoiding a lock for.
    const running = await this.projects.countRunningByOwner(ownerId);
    const startNow = running < this.maxActiveProjects;
    // Only needed for the "you're Nth in line" message when we're not starting.
    const waiting = startNow ? [] : await this.projects.listQueuedByOwner(ownerId);

    const options = GenerationOptions.create(dto.options);
    const id = ProjectId.from(this.ids.uuid());
    const project = Project.create({
      id,
      ownerId,
      channelUrl: url.value,
      options,
      now: this.clock.now(),
    });
    if (project.isFail()) return Result.fail(project.error);

    const advance = project.value.advanceTo(startNow ? 'INGESTING_CHANNEL' : 'QUEUED', this.clock.now());
    if (advance.isFail()) return Result.fail(advance.error);

    // Persist BEFORE enqueuing: the worker loads the project by id, so the row
    // has to exist by the time the job is picked up.
    await this.projects.save(project.value);
    if (startNow) {
      await this.queue.enqueue(
        'channel-ingest',
        { projectId: id.value },
        { jobId: `channel-ingest:${id.value}` },
      );
    }

    return Result.ok({
      projectId: id.value,
      status: project.value.status.value,
      queued: !startNow,
      queuePosition: startNow ? 0 : waiting.length + 1,
    });
  }
}
