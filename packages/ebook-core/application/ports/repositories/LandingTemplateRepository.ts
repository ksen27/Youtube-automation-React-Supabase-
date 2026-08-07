import type { Result } from '../../../domain/shared/Result';
import type { StoredLandingTemplate, TemplateAsset } from '../../../domain/landing/TemplateManifest';

/**
 * Cloned templates, scoped to the account that extracted them.
 *
 * Owner-scoped unlike `LandingLayoutRepository`, which it replaces. That table
 * held markup a model wrote after looking at a page, with every word stripped
 * out — nothing in it belonged to anyone, and sharing it across accounts is what
 * made the cache worth having. A template row is a complete copy of a website.
 * Sharing one leaks which template a seller uses and raises an ownership
 * question the system is not entitled to answer for them.
 */
export interface LandingTemplateRepository {
  findById(id: string): Promise<StoredLandingTemplate | null>;

  /**
   * The current template for this owner and URL at the running pipeline
   * version, newest revision first. A pipeline-version bump returns null, which
   * is what makes an extraction fix reach existing templates automatically.
   */
  findCurrent(ownerId: string, sourceUrl: string, pipelineVersion: number): Promise<StoredLandingTemplate | null>;

  listByOwner(ownerId: string): Promise<StoredLandingTemplate[]>;

  /** Creates the row in EXTRACTING so the UI can show progress immediately. */
  create(input: {
    id: string;
    ownerId: string;
    sourceUrl: string;
    pipelineVersion: number;
    revision: number;
  }): Promise<Result<void>>;

  /** Writes the extraction result and flips the row to READY or FAILED. */
  save(template: StoredLandingTemplate): Promise<Result<void>>;

  /** The re-hosted assets a page built on this template must deploy. */
  listAssets(templateId: string): Promise<TemplateAsset[]>;

  saveAssets(templateId: string, assets: TemplateAsset[]): Promise<Result<void>>;

  /** User corrections to the annotation, preserved across re-extractions. */
  saveOverrides(templateId: string, overrides: StoredLandingTemplate['overrides']): Promise<Result<void>>;

  remove(id: string): Promise<Result<void>>;
}
