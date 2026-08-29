import type { Project } from '../../../domain/project/Project';
import type { ProjectId } from '../../../domain/project/ProjectId';
import type { ProjectState } from '../../../domain/project/ProjectStatus';

/** Lightweight read-model row for listing a user's projects (no aggregate load). */
export interface ProjectListItem {
  id: string;
  /**
   * The title the user gave at submit. Null only for books created before the
   * title became a required input.
   */
  bookTitle: string | null;
  status: ProjectState;
  createdAt: string;
}

/**
 * A finished book that could be sold alongside another on one landing page.
 * Richer than ProjectListItem because a picker has to SHOW the book — a list of
 * project UUIDs is not something anyone can choose from.
 */
export interface LandingCandidate {
  projectId: string;
  bookTitle: string;
  /** Storage path of the cover, for the picker's thumbnail. */
  coverImagePath: string | null;  createdAt: string;
  /**
   * The book's OWN commerce settings, so the picker can show what it already
   * sells for the moment it is chosen — and so the seller can tell "this book
   * is ready to sell" from "this book still needs a product" without leaving
   * the form.
   *
   * These are the same values the renderers now resolve from (see
   * `siblingCommerce`), which is what makes the preview honest rather than a
   * second, hopeful copy of the truth.
   */
  priceCents: number | null;
  compareAtCents: number | null;
  checkoutUrl: string | null;
  /** Set only when WE created the store product — see GenerationOptions. */
  checkoutProductKey: string | null;
}

export interface ProjectRepository {
  findById(id: ProjectId): Promise<Project | null>;
  save(project: Project): Promise<void>;
  /** Atomic per-stage fan-in counter decrement; returns remaining count. */
  decrementPending(id: ProjectId, stage: string): Promise<number>;
  /**
   * Atomically transition status from any of `from` to `to` in a single guarded
   * write. Returns true iff THIS call performed the transition. Concurrency-safe:
   * when many fan-in jobs converge at once, exactly one wins and the rest no-op,
   * so the status can't be clobbered by racing read-modify-write saves.
   */
  advanceStatusAtomic(id: ProjectId, from: ProjectState[], to: ProjectState): Promise<boolean>;
  /** List a user's projects, newest first (read model for the dashboard). */
  listByOwner(ownerId: string): Promise<ProjectListItem[]>;
  /**
   * How many of a user's projects are actually consuming worker capacity —
   * non-terminal and not QUEUED. Backs the per-user concurrency cap.
   */
  countRunningByOwner(ownerId: string): Promise<number>;
  /** A user's QUEUED projects, oldest first — the order they'll be started in. */
  listQueuedByOwner(ownerId: string): Promise<ProjectListItem[]>;
  /**
   * The user's other finished books, for the three-book page's picker.
   *
   * Scoped to one owner because putting another account's book on your sales
   * page is not a thing we allow, and restricted to COMPLETED projects because
   * an unfinished book has no cover, no outline and no page count — its card
   * would render half-empty.
   */
  listLandingCandidates(ownerId: string, excludeProjectId: ProjectId): Promise<LandingCandidate[]>;
}
