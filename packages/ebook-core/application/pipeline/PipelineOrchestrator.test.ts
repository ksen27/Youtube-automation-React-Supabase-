import { describe, it, expect } from 'vitest';
import { PipelineOrchestrator } from './PipelineOrchestrator';
import { Project } from '../../domain/project/Project';
import { ProjectId } from '../../domain/project/ProjectId';
import { GenerationOptions } from '../../domain/project/GenerationOptions';
import { ChannelUrl } from '../../domain/channel/ChannelUrl';
import type { ProjectRepository, ProjectListItem, LandingCandidate } from '../ports/repositories/ProjectRepository';
import type { ProjectState } from '../../domain/project/ProjectStatus';
import type { JobQueue, QueueName } from '../ports/services/JobQueue';
import type { Clock } from '../ports/Clock';
import type { Logger } from '../ports/Logger';

const now = new Date('2026-01-01T00:00:00Z');

function failedProject(id = 'p1'): Project {
  const url = ChannelUrl.create('https://www.youtube.com/@example') as { value: ChannelUrl };
  const p = Project.create({
    id: ProjectId.from(id),
    ownerId: 'u1',
    channelUrl: url.value,
    options: GenerationOptions.create({}),
    now,
  }).value;
  p.advanceTo('INGESTING_CHANNEL', now);
  p.markFailed('Stage book-strategy failed', now);
  return p;
}

class FakeProjectRepo implements ProjectRepository {
  saved: Project[] = [];
  constructor(private project: Project | null) {}
  async findById(id: ProjectId): Promise<Project | null> {
    return this.project && this.project.id.value === id.value ? this.project : null;
  }
  async save(project: Project): Promise<void> {
    this.saved.push(project);
  }
  async decrementPending(): Promise<number> {
    return 0;
  }
  async advanceStatusAtomic(id: ProjectId, from: ProjectState[], to: ProjectState): Promise<boolean> {
    if (!this.project || this.project.id.value !== id.value) return false;
    if (!from.includes(this.project.status.value)) return false;
    this.project.advanceTo(to, now);
    this.saved.push(this.project);
    return true;
  }
  async listByOwner(): Promise<ProjectListItem[]> {
    return [];
  }
  async countRunningByOwner(): Promise<number> {
    return 0;
  }
  async listQueuedByOwner(): Promise<ProjectListItem[]> {
    return [];
  }
  async listLandingCandidates(): Promise<LandingCandidate[]> {
    return [];
  }
}

class FakeQueue implements JobQueue {
  retryFailedCalls = 0;
  drainCalls = 0;
  constructor(private failed: QueueName[]) {}
  async enqueue(): Promise<void> {}
  async failedStages(): Promise<QueueName[]> {
    return this.failed;
  }
  async retryFailed(): Promise<number> {
    this.retryFailedCalls += 1;
    return this.failed.length;
  }
  async drain(): Promise<number> {
    this.drainCalls += 1;
    return 0;
  }
}

const clock: Clock = { now: () => now };
const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

describe('PipelineOrchestrator.resume', () => {
  it('rewinds a FAILED project to the failed stage and retries its jobs', async () => {
    const project = failedProject();
    const repo = new FakeProjectRepo(project);
    const queue = new FakeQueue(['book-strategy']);
    const orch = new PipelineOrchestrator(repo, queue, clock, logger);

    const result = await orch.resume('p1');

    expect(result.retried).toBe(1);
    expect(result.stage).toBe('GENERATING_BOOK_STRATEGY');
    expect(project.status.value).toBe('GENERATING_BOOK_STRATEGY');
    expect(repo.saved).toHaveLength(1);
    expect(queue.retryFailedCalls).toBe(1);
  });

  it('rewinds to the EARLIEST stage when several queues failed', async () => {
    const project = failedProject();
    const repo = new FakeProjectRepo(project);
    const queue = new FakeQueue(['chapter-generate', 'video-summarize']);
    const orch = new PipelineOrchestrator(repo, queue, clock, logger);

    const result = await orch.resume('p1');

    expect(result.stage).toBe('SUMMARIZING_VIDEOS');
    expect(project.status.value).toBe('SUMMARIZING_VIDEOS');
  });

  it('does nothing for a project that is not FAILED', async () => {
    const url = ChannelUrl.create('https://www.youtube.com/@example') as { value: ChannelUrl };
    const project = Project.create({
      id: ProjectId.from('p1'),
      ownerId: 'u1',
      channelUrl: url.value,
      options: GenerationOptions.create({}),
      now,
    }).value;
    project.advanceTo('INGESTING_CHANNEL', now);

    const repo = new FakeProjectRepo(project);
    const queue = new FakeQueue(['book-strategy']);
    const orch = new PipelineOrchestrator(repo, queue, clock, logger);

    const result = await orch.resume('p1');
    expect(result.retried).toBe(0);
    expect(queue.retryFailedCalls).toBe(0);
    expect(project.status.value).toBe('INGESTING_CHANNEL');
  });

  it('does nothing when there are no failed jobs to retry', async () => {
    const project = failedProject();
    const repo = new FakeProjectRepo(project);
    const queue = new FakeQueue([]);
    const orch = new PipelineOrchestrator(repo, queue, clock, logger);

    const result = await orch.resume('p1');
    expect(result.retried).toBe(0);
    expect(queue.retryFailedCalls).toBe(0);
    expect(project.status.value).toBe('FAILED');
  });

  it('returns retried:0 for an unknown project', async () => {
    const repo = new FakeProjectRepo(null);
    const queue = new FakeQueue(['book-strategy']);
    const orch = new PipelineOrchestrator(repo, queue, clock, logger);

    const result = await orch.resume('missing');
    expect(result.retried).toBe(0);
  });
});
