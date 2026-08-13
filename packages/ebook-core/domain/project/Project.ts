import { AggregateRoot } from '../shared/AggregateRoot';
import { Result } from '../shared/Result';
import { ProjectId } from './ProjectId';
import { ProjectStatus, type ProjectState } from './ProjectStatus';
import { GenerationOptions } from './GenerationOptions';
import { ChannelUrl } from '../channel/ChannelUrl';
import { ProjectStatusChanged } from './events/ProjectStatusChanged';

interface ProjectProps {
  ownerId: string;
  channelUrl: ChannelUrl;
  options: GenerationOptions;
  status: ProjectStatus;
  /** Per-stage fan-in counters, e.g. { GENERATING_CHAPTERS: 12 }. */
  pendingCounts: Record<string, number>;
  version: number;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class Project extends AggregateRoot<ProjectProps, ProjectId> {
  static create(input: {
    id: ProjectId;
    ownerId: string;
    channelUrl: ChannelUrl;
    options: GenerationOptions;
    now: Date;
  }): Result<Project> {
    if (input.ownerId.trim().length === 0) return Result.fail('ownerId is required');
    return Result.ok(
      new Project(
        {
          ownerId: input.ownerId,
          channelUrl: input.channelUrl,
          options: input.options,
          status: ProjectStatus.created(),
          pendingCounts: {},
          version: 0,
          createdAt: input.now,
          updatedAt: input.now,
        },
        input.id,
      ),
    );
  }

  /** Rehydrate from persistence (no events, no validation re-run). */
  static rehydrate(props: ProjectProps, id: ProjectId): Project {
    return new Project(props, id);
  }

  get status(): ProjectStatus {
    return this.props.status;
  }
  get ownerId(): string {
    return this.props.ownerId;
  }
  get channelUrl(): ChannelUrl {
    return this.props.channelUrl;
  }
  get options(): GenerationOptions {
    return this.props.options;
  }
  get version(): number {
    return this.props.version;
  }
  get error(): string | undefined {
    return this.props.error;
  }
  get pendingCounts(): Readonly<Record<string, number>> {
    return this.props.pendingCounts;
  }

  /** The state machine: illegal transitions are rejected as failures, not thrown. */
  advanceTo(next: ProjectState, now: Date): Result<void> {
    const target = ProjectStatus.of(next);
    if (!this.props.status.canTransitionTo(target)) {
      return Result.fail(`Illegal transition ${this.props.status.value} → ${next}`);
    }
    const from = this.props.status.value;
    this.props.status = target;
    this.props.updatedAt = now;
    this.addEvent(new ProjectStatusChanged(this.id.value, from, next, now));
    return Result.ok();
  }

  markFailed(reason: string, now: Date): Result<void> {
    if (this.props.status.isTerminal()) return Result.ok(); // already terminal — idempotent
    const from = this.props.status.value;
    this.props.status = ProjectStatus.of('FAILED');
    this.props.error = reason;
    this.props.updatedAt = now;
    this.addEvent(new ProjectStatusChanged(this.id.value, from, 'FAILED', now));
    return Result.ok();
  }

  /** User-initiated cancellation. Terminal (maps to FAILED); the error marks intent. */
  cancel(now: Date): Result<void> {
    if (this.props.status.value === 'COMPLETED') return Result.fail('Cannot cancel a completed project');
    return this.markFailed('Cancelled by user', now);
  }

  /**
   * Retry support: force the status back to a previously-attempted stage,
   * bypassing the transition table (FAILED → stage is otherwise illegal). Only
   * the PipelineOrchestrator should call this, after re-queuing the failed jobs.
   */
  resumeAt(stage: ProjectState, now: Date): Result<void> {
    if (!this.props.status.isTerminal()) return Result.fail('Project is not in a terminal state');
    const from = this.props.status.value;
    this.props.status = ProjectStatus.of(stage);
    delete this.props.error;
    this.props.updatedAt = now;
    this.addEvent(new ProjectStatusChanged(this.id.value, from, stage, now));
    return Result.ok();
  }

  /**
   * Update the landing-page settings after submission. The checkout link is the
   * one field that genuinely cannot be known at submit time — the book has to
   * exist before it can be uploaded to a store — so it stays editable for the
   * life of the project. Absent keys are left untouched.
   */
  updateLandingSettings(
    changes: {
      landingPage?: boolean | undefined;
      landingCheckoutUrl?: string | undefined;
      landingPriceCents?: number | undefined;
      landingCompareAtCents?: number | undefined;
      landingCurrency?: string | undefined;
      landingGuaranteeDays?: number | undefined;
      landingTemplateUrl?: string | undefined;
      /** The cloned template to build this page from; unset → built-in renderer. */
      landingTemplateId?: string | undefined;
      landingMode?: 'single' | 'triple' | undefined;
      landingSiblings?:
        | Array<{
            projectId: string;
            priceCents?: number | undefined;
            compareAtCents?: number | undefined;
            checkoutUrl?: string | undefined;
          }>
        | undefined;
      landingBundlePriceCents?: number | undefined;
      landingBundleCheckoutUrl?: string | undefined;
      landingAuthorPhotoPath?: string | undefined;
    },
    now: Date,
  ): void {
    const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    this.props.options = GenerationOptions.create({ ...this.props.options.toJSON(), ...defined });
    this.props.updatedAt = now;
  }

  /** Set the expected number of fan-out children for a stage barrier. */
  setPending(stage: string, count: number): void {
    this.props.pendingCounts = { ...this.props.pendingCounts, [stage]: count };
  }
}
