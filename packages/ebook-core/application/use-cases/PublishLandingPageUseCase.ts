import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { LandingPageRepository } from '../ports/repositories/LandingPageRepository';
import type { SiteFile, SitePublisher } from '../ports/services/SitePublisher';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { LandingTemplateRepository } from '../ports/repositories/LandingTemplateRepository';
import type { TemplateArtifactStore } from '../ports/services/TemplateArtifactStore';
import type { Clock } from '../ports/Clock';

/** Where a cloned template's assets live. Private; read with the service role. */
const LANDING_BUCKET = 'landing-assets';

/**
 * Deploys the current draft to Netlify.
 *
 * Kept separate from generation on purpose: AI-written marketing copy should be
 * read by a human before it reaches a public URL, and — more concretely — a page
 * with no checkout link would be a live sales page nobody can buy from. Both are
 * enforced here rather than left to the caller.
 */
export class PublishLandingPageUseCase {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly books: BookRepository,
    private readonly pages: LandingPageRepository,
    private readonly publisher: SitePublisher,
    private readonly clock: Clock,
    /**
     * The three below are only used by the clone engine, which deploys several
     * files rather than one. Optional so the built-in path — and every existing
     * test of it — is unchanged.
     */
    private readonly templates?: LandingTemplateRepository,
    private readonly artifacts?: TemplateArtifactStore,
    private readonly storage?: ObjectStorage,
  ) {}

  async execute(input: { projectId: string }): Promise<Result<{ url: string }>> {
    const projectId = ProjectId.from(input.projectId);
    const project = await this.projects.findById(projectId);
    if (!project) return Result.fail('Project not found');
    if (!this.publisher.isConfigured()) {
      return Result.fail('Publishing is not configured — set NETLIFY_AUTH_TOKEN');
    }
    // The one hard gate: a live page whose buttons go nowhere is worse than no
    // page at all. On a three-book page EVERY book is checked, not just the
    // first — one link set would otherwise publish a page with two dead buttons
    // that silently take no money.
    const missing = project.options.missingCheckoutPositions();
    if (missing.length > 0) {
      return Result.fail(
        missing.length === 1 && !project.options.isTripleLanding
          ? 'Add your checkout link before publishing — the buy buttons have nowhere to go'
          : `Add a checkout link for ${missing.length === 1 ? 'book' : 'books'} ${missing.join(', ')} before publishing — those buy buttons have nowhere to go`,
      );
    }

    const page = await this.pages.findByProject(projectId);
    if (!page) return Result.fail('No landing page has been generated yet');
    const html = page.html;
    if (!html) return Result.fail('Nothing to publish — generate the page first');

    // The verification gate. A cloned page whose buy buttons still point at the
    // template owner's store, or that carries an unfilled token as literal
    // braces, is worse live than absent — and this is the first version of the
    // system that can tell, because v1's checks all ran before substitution.
    if (!page.isPublishable) {
      return Result.fail(
        `This page did not pass verification and will not be published: ${page.blockers.slice(0, 3).join(' · ')}`,
      );
    }

    const marked = page.markPublishing(this.clock.now());
    if (marked.isFail()) return Result.fail(marked.error);
    // State only: the html is what we are about to publish, not something to
    // rewrite. Re-saving megabytes to flip an enum is what timed out.
    await this.pages.saveState(page);

    const book = await this.books.findSummaryByProject(projectId);
    const title = book?.title ?? project.options.bookTitle ?? 'book';

    // A cloned page carries its images and fonts as files beside it; the
    // built-in renderer still inlines everything and deploys one file. The
    // Netlify adapter has always taken a file list, so neither needs a special
    // case here beyond loading the bytes.
    const files: SiteFile[] = [{ path: 'index.html', bytes: new TextEncoder().encode(html) }];
    const assets = await this.loadAssets(page.templateId, page.assets);
    if (assets.isFail()) return this.fail(page, assets.error);
    files.push(...assets.value);

    const published = await this.publisher.publish({
      ...(page.siteId ? { siteId: page.siteId } : {}),
      preferredName: title,
      files,
    });

    if (published.isFail()) return this.fail(page, published.error);

    page.markPublished(published.value, this.clock.now());
    await this.pages.save(page);
    return Result.ok({ url: published.value.url });
  }

  private async fail(page: Awaited<ReturnType<LandingPageRepository['findByProject']>>, reason: string) {
    if (page) {
      page.markFailed(reason, this.clock.now());
      await this.pages.saveState(page);
    }
    return Result.fail<{ url: string }>(reason);
  }

  /**
   * The template's assets plus this page's own cover, portrait and brand mark.
   *
   * A missing asset is fatal rather than skipped: deploying a page whose hero
   * image 404s looks broken to every visitor, and the fix is to regenerate,
   * which the seller can only do if they are told.
   */
  private async loadAssets(
    templateId: string | null,
    pageAssets: Array<{ sitePath: string; storagePath: string; contentType: string }>,
  ): Promise<Result<SiteFile[]>> {
    if (pageAssets.length === 0 && !templateId) return Result.ok([]);
    if (!this.storage) return Result.fail("Storage is not configured, so this page's assets cannot be deployed");

    const files: SiteFile[] = [];
    const seen = new Set<string>();

    if (templateId && this.templates && this.artifacts) {
      const templateAssets = await this.templates.listAssets(templateId);
      for (const loaded of await this.artifacts.loadAssets(templateAssets)) {
        if (seen.has(loaded.sitePath)) continue;
        seen.add(loaded.sitePath);
        files.push({ path: loaded.sitePath, bytes: loaded.bytes });
      }
    }

    for (const asset of pageAssets) {
      if (seen.has(asset.sitePath)) continue;
      const bytes = await this.storage.getBytes(LANDING_BUCKET, asset.storagePath);
      if (bytes.isFail()) return Result.fail(`Could not read ${asset.sitePath} for the deploy: ${bytes.error}`);
      seen.add(asset.sitePath);
      files.push({ path: asset.sitePath, bytes: bytes.value.bytes });
    }

    return Result.ok(files);
  }
}
