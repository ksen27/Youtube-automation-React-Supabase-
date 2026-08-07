import type { LandingPage } from '../../../domain/landing/LandingPage';
import type { ProjectId } from '../../../domain/project/ProjectId';

/** One landing page per project, so the project id is the natural lookup key. */
export interface LandingPageRepository {
  findByProject(projectId: ProjectId): Promise<LandingPage | null>;
  save(page: LandingPage): Promise<void>;
  /**
   * Persist ONLY the page's state, error and timestamp.
   *
   * `save` writes every column including `html` — a self-contained page with
   * its cover art embedded as base64, which runs to megabytes and more still
   * on a three-book page carrying three covers. Status flips (GENERATING,
   * FAILED, PUBLISHING) were rewriting that entire payload just to change one
   * enum, which is what pushed `landing_pages.save` past the database's
   * statement timeout.
   */
  saveState(page: LandingPage): Promise<void>;
}
