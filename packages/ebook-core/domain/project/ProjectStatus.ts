import { ValueObject } from '../shared/ValueObject';

export type ProjectState =
  | 'CREATED'
  /** Accepted but deliberately not started — waiting for a concurrency slot. */
  | 'QUEUED'  | 'GENERATING_BOOK_STRATEGY'
  | 'GENERATING_OUTLINE'
  | 'GENERATING_CHAPTER_RESEARCH'
  | 'GENERATING_CHAPTERS'
  | 'POLISHING_BOOK'
  | 'ASSEMBLING'
  | 'EXPORTING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED';

/**
 * States a project can never leave. Everything else — including PARTIAL, which
 * resumes at ANALYZING_COMMENTS — still has pipeline work ahead of it.
 */
export const TERMINAL_STATES: readonly ProjectState[] = ['COMPLETED', 'FAILED'];

/**
 * States that consume no worker capacity: finished, or accepted-but-not-started.
 * A project counts against the per-user concurrency cap only when it is outside
 * this set — that's what lets a user submit any number of books while at most
 * `MAX_ACTIVE_PROJECTS_PER_USER` of them actually run.
 */
export const NOT_RUNNING_STATES: readonly ProjectState[] = [...TERMINAL_STATES, 'QUEUED'];

/** Explicit transition table — the full 15-phase pipeline contract lives here. */
const TRANSITIONS: Record<ProjectState, ProjectState[]> = {
  CREATED: ['GENERATING_BOOK_STRATEGY', 'QUEUED', 'FAILED'],
  // Held back at submit time; the admission controller starts it when a slot frees.
  QUEUED: ['GENERATING_BOOK_STRATEGY', 'FAILED'],  GENERATING_BOOK_STRATEGY: ['GENERATING_OUTLINE', 'FAILED'],
  GENERATING_OUTLINE: ['GENERATING_CHAPTER_RESEARCH', 'FAILED'],
  GENERATING_CHAPTER_RESEARCH: ['GENERATING_CHAPTERS', 'FAILED'],
  GENERATING_CHAPTERS: ['POLISHING_BOOK', 'FAILED'],
  POLISHING_BOOK: ['ASSEMBLING', 'FAILED'],
  ASSEMBLING: ['EXPORTING', 'FAILED'],
  EXPORTING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  PARTIAL: ['FAILED'],
};

export class ProjectStatus extends ValueObject<{ value: ProjectState }> {
  static of(value: ProjectState): ProjectStatus {
    return new ProjectStatus({ value });
  }
  static created(): ProjectStatus {
    return ProjectStatus.of('CREATED');
  }

  get value(): ProjectState {
    return this.props.value;
  }

  canTransitionTo(next: ProjectStatus): boolean {
    return TRANSITIONS[this.props.value].includes(next.value);
  }

  isTerminal(): boolean {
    return TERMINAL_STATES.includes(this.props.value);
  }
}
