import { AggregateRoot } from '../shared/AggregateRoot';
import { Result } from '../shared/Result';
import { ProjectId } from './ProjectId';
import { ProjectStatus, type ProjectState } from './ProjectStatus';
import { GenerationOptions } from './GenerationOptions';
import { ProjectStatusChanged } from './events/ProjectStatusChanged';

interface ProjectProps {
  ownerId: string;
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
    options: GenerationOptions;
    now: Date;
  }): Result<Project> {
    if (input.ownerId.trim().length === 0) return Result.fail('ownerId is required');
    return Result.ok(
      new Project(
        {
          ownerId: input.ownerId,
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
    const current = this.props.options.toJSON();
    // Pointing the buy button somewhere ELSE disowns the product we created for
    // this book: the stored key no longer describes where the money goes, and
    // leaving it behind would make a later "create the product" click hand back
    // a link the seller had already replaced by hand. Compared rather than
    // cleared on every write, because the settings form PATCHes the checkout
    // field on every save — including saves that leave our own generated link
    // exactly as it was.
    const replacedByHand =
      changes.landingCheckoutUrl !== undefined &&
      changes.landingCheckoutUrl.trim() !== (current.landingCheckoutUrl ?? '');
    if (replacedByHand) delete current.landingCheckoutProductKey;
    this.props.options = GenerationOptions.create({ ...current, ...defined });
    this.props.updatedAt = now;
  }

  /**
   * Record the store product created for this book, and point the page's buy
   * button at it.
   *
   * Both fields move together and only here: the URL is what every CTA renders,
   * the key is what stops a second run from listing the book twice. Writing one
   * without the other is the bug this method exists to make impossible.
   */
  attachCheckoutProduct(product: { productKey: string; buyUrl: string }, now: Date): void {
    this.props.options = GenerationOptions.create({
      ...this.props.options.toJSON(),
      landingCheckoutUrl: product.buyUrl,
      landingCheckoutProductKey: product.productKey,
    });
    this.props.updatedAt = now;
  }

  /** Set the expected number of fan-out children for a stage barrier. */
  setPending(stage: string, count: number): void {
    this.props.pendingCounts = { ...this.props.pendingCounts, [stage]: count };
  }
}
