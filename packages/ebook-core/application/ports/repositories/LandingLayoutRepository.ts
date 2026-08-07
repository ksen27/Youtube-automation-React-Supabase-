import type { Result } from '../../../domain/shared/Result';
import type { CopySlot } from '../../landing/pageContract';
import type { LandingMode } from '../../../domain/project/GenerationOptions';

/**
 * A layout copied from a reference site, reusable by every book that follows
 * that template.
 *
 * Holds no book's prose — the markup carries {{COPY:…}} slots, and `slots`
 * describes each one so the copy call knows what to write for it.
 */
export interface StoredLandingLayout {
  referenceUrl: string;
  mode: LandingMode;
  css: string;
  bodyHtml: string;
  slots: CopySlot[];
  inputHash: string | null;
}

export interface LandingLayoutRepository {
  /** The stored layout for this template, or null if none has been captured. */
  find(referenceUrl: string, mode: LandingMode): Promise<StoredLandingLayout | null>;
  /** Stores or replaces the layout for this template. */
  save(layout: StoredLandingLayout): Promise<Result<void>>;
}
