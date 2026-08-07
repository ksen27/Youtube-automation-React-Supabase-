import { describe, it, expect } from 'vitest';
import { SubmitChannelUseCase } from './SubmitChannelUseCase';
import { StartQueuedProjectsUseCase } from './StartQueuedProjectsUseCase';
import type { ProjectRepository, ProjectListItem, LandingCandidate } from '../ports/repositories/ProjectRepository';
import type { JobQueue, QueueName } from '../ports/services/JobQueue';
import type { Project } from '../../domain/project/Project';
import type { ProjectId } from '../../domain/project/ProjectId';
import type { ProjectState } from '../../domain/project/ProjectStatus';
import type { SubmitChannelDto } from '../dto/SubmitChannel.dto';

const now = new Date('2026-01-01T00:00:00Z');

const dto: SubmitChannelDto = {
  channelUrl: 'https://www.youtube.com/@example',
  options: {
    bookTitle: 'A Book',
    bookType: 'normal',
    targetPages: 100,
    maxVideos: 30,
    recipeCount: 60,
    tone: 'professional',
    includeComments: true,
    includeIllustrations: true,
    illustrationEveryPages: 5,
    landingPage: false,
    landingCurrency: 'USD',
    landingGuaranteeDays: 30,
    landingMode: 'single',
    landingSiblings: [],
  },
};

class FakeProjectRepo implements ProjectRepository {
  saved: Project[] = [];
  /** ids the caller successfully transitioned QUEUED → INGESTING_CHANNEL */
  promoted: string[] = [];
  constructor(
    private readonly running: number,
    private queued: ProjectListItem[] = [],
  ) {}
  async findById(): Promise<Project | null> {
    return null;
  }
  async save(project: Project): Promise<void> {
    this.saved.push(project);
  }
  async decrementPending(): Promise<number> {
    return 0;
  }
  async advanceStatusAtomic(id: ProjectId, from: ProjectState[], to: ProjectState): Promise<boolean> {
    if (!from.includes('QUEUED') || to !== 'INGESTING_CHANNEL') return false;
    if (!this.queued.some((q) => q.id === id.value)) return false;
    this.queued = this.queued.filter((q) => q.id !== id.value);
    this.promoted.push(id.value);
    return true;
  }
  async listByOwner(): Promise<ProjectListItem[]> {
    return [];
  }
  async countRunningByOwner(): Promise<number> {
    return this.running;
  }
  async listQueuedByOwner(): Promise<ProjectListItem[]> {
    return this.queued;
  }
  async listLandingCandidates(): Promise<LandingCandidate[]> {
    return [];
  }
}

class FakeQueue implements JobQueue {
  enqueued: QueueName[] = [];
  async enqueue(queue: QueueName): Promise<void> {
    this.enqueued.push(queue);
  }
  async failedStages(): Promise<QueueName[]> {
    return [];
  }
  async retryFailed(): Promise<number> {
    return 0;
  }
  async drain(): Promise<number> {
    return 0;
  }
}

function queuedItem(id: string, createdAt: string): ProjectListItem {
  return { id, channelUrl: 'https://www.youtube.com/@example', status: 'QUEUED', createdAt };
}

function buildSubmit(running: number, max: number, queued: ProjectListItem[] = []) {
  const projects = new FakeProjectRepo(running, queued);
  const queue = new FakeQueue();
  let n = 0;
  const useCase = new SubmitChannelUseCase(
    projects,
    queue,
    { uuid: () => `p${++n}` },
    { now: () => now },
    max,
  );
  return { useCase, projects, queue };
}

describe('SubmitChannelUseCase concurrency cap', () => {
  it('starts a book immediately while below the cap', async () => {
    const { useCase, projects, queue } = buildSubmit(2, 3);

    const result = await useCase.execute('u1', dto);

    expect(result.isOk()).toBe(true);
    expect((result as { value: { status: string; queued: boolean } }).value).toMatchObject({
      status: 'INGESTING_CHANNEL',
      queued: false,
    });
    expect(projects.saved).toHaveLength(1);
    expect(queue.enqueued).toEqual(['channel-ingest']);
  });

  it('accepts a book over the cap and parks it in QUEUED without enqueuing work', async () => {
    const { useCase, projects, queue } = buildSubmit(3, 3);

    const result = await useCase.execute('u1', dto);

    expect(result.isOk()).toBe(true);
    expect((result as { value: { status: string; queued: boolean; queuePosition: number } }).value).toMatchObject({
      status: 'QUEUED',
      queued: true,
      queuePosition: 1,
    });
    // Saved (so the user sees it) but NOT enqueued — no worker capacity consumed.
    expect(projects.saved).toHaveLength(1);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('reports the position behind books already waiting', async () => {
    const { useCase } = buildSubmit(3, 3, [queuedItem('a', '2026-01-01'), queuedItem('b', '2026-01-02')]);

    const result = await useCase.execute('u1', dto);

    expect((result as { value: { queuePosition: number } }).value.queuePosition).toBe(3);
  });

  it('validates the channel URL before touching the repository', async () => {
    const { useCase, projects, queue } = buildSubmit(0, 3);

    const result = await useCase.execute('u1', { ...dto, channelUrl: 'not-a-channel' });

    expect(result.isFail()).toBe(true);
    expect(projects.saved).toHaveLength(0);
    expect(queue.enqueued).toHaveLength(0);
  });
});

describe('StartQueuedProjectsUseCase', () => {
  it('starts exactly as many queued books as there are free slots, oldest first', async () => {
    const projects = new FakeProjectRepo(1, [
      queuedItem('oldest', '2026-01-01'),
      queuedItem('middle', '2026-01-02'),
      queuedItem('newest', '2026-01-03'),
    ]);
    const queue = new FakeQueue();

    const started = await new StartQueuedProjectsUseCase(projects, queue, 3).promoteForOwner('u1');

    expect(started).toBe(2); // 3 slots - 1 running
    expect(projects.promoted).toEqual(['oldest', 'middle']);
    expect(queue.enqueued).toEqual(['channel-ingest', 'channel-ingest']);
  });

  it('starts nothing while the cap is still full', async () => {
    const projects = new FakeProjectRepo(3, [queuedItem('waiting', '2026-01-01')]);
    const queue = new FakeQueue();

    const started = await new StartQueuedProjectsUseCase(projects, queue, 3).promoteForOwner('u1');

    expect(started).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('does not enqueue for a project another caller already claimed', async () => {
    // advanceStatusAtomic returns false for an id that is no longer QUEUED.
    const projects = new FakeProjectRepo(0, [queuedItem('taken', '2026-01-01')]);
    await projects.advanceStatusAtomic(
      { value: 'taken' } as ProjectId,
      ['QUEUED'],
      'INGESTING_CHANNEL',
    );
    const queue = new FakeQueue();

    const started = await new StartQueuedProjectsUseCase(projects, queue, 3).promoteForOwner('u1');

    expect(started).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
  });
});
