import { z } from 'zod';
import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { siblingCommerce } from '../landing/siblingCommerce';
import {
  LandingPage,
  LandingPageId,
  type LandingBinding,
  type LandingCopy,
  type LandingFidelity,
  type LandingPageAsset,
} from '../../domain/landing/LandingPage';
import { normalizeBookTitle } from '../../domain/project/GenerationOptions';
import { adaptTheme } from '../../domain/landing/ThemeAdaptation';
import {
  REPEATER_PLACEHOLDERS,
  REQUIRED_PLACEHOLDERS,
  isCopyKey,
  splitRepeaterField,
} from '../../domain/landing/PlaceholderVocabulary';
import type { Finding, PlaceholderEntry, Rect, StoredLandingTemplate } from '../../domain/landing/TemplateManifest';
import { validateBoundPage } from '../landing/templateContract';
import { TemplateCopyPrompt } from '../prompts/TemplateCopyPrompt';
import { parseJsonCompletion } from '../prompts/parse';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { KnowledgeRepository } from '../ports/repositories/KnowledgeRepository';
import type { ChannelRepository } from '../ports/repositories/ChannelRepository';
import type { ExportArtifactRepository } from '../ports/repositories/ExportArtifactRepository';
import type { LandingPageRepository } from '../ports/repositories/LandingPageRepository';
import type { LandingTemplateRepository } from '../ports/repositories/LandingTemplateRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { ImageColorSampler } from '../ports/services/ImageColorSampler';
import type { ImageProcessor } from '../ports/services/ImageProcessor';
import type { RemoteImageFetcher } from '../ports/services/RemoteImageFetcher';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { TemplateArtifactStore } from '../ports/services/TemplateArtifactStore';
import type { TemplateCapturer } from '../ports/services/TemplateCapturer';
import type { PageDiffer } from '../ports/services/PageDiffer';
import type { LandingPageBinder } from '../ports/services/LandingPageBinder';
import type { IdGenerator } from '../ports/IdGenerator';
import type { Clock } from '../ports/Clock';
import type { Hasher } from '../ports/Hasher';

const EXPORTS_BUCKET = 'ebook-exports';

/** Widths every generated page is verified at. */
const VERIFY_WIDTHS = [1280, 768, 390];

/**
 * How far the bound page may differ from the template OUTSIDE the regions where
 * content was replaced on purpose.
 *
 * Everything else on the page is the template's own markup and CSS, so a
 * difference here is not a design choice — it is something that moved, and the
 * usual cause is copy overflowing a box the template sized for shorter words.
 */
const MAX_UNMASKED_DRIFT = 0.02;

/**
 * A masked region that barely changed usually means a placeholder never got a
 * value and the node collapsed, leaving the template's own layout with a hole.
 */
const MIN_MASKED_CHANGE = 0.005;

/**
 * Items to request for a repeater whose container was never measured.
 *
 * Only used by the orphaned-field recovery below: the real count comes from the
 * detected container, and when there isn't one the template's own markup decides
 * how many cards exist. Twelve covers a typical chapter grid or FAQ list without
 * asking the model for prose nobody will see.
 */
const DEFAULT_REPEATER_COUNT = 12;

const CopyResponseSchema = z.object({
  slots: z.record(z.string()).default({}),
  repeats: z.record(z.array(z.record(z.string()))).default({}),
});

/**
 * Displayed image widths, in device pixels — roughly 2× their CSS width.
 *
 * The PORTRAIT is sized well above that rule on purpose. Templates frame the
 * author in a circle or a square with `object-fit: cover`, which keeps the
 * middle and throws the sides away — so a 400px upload showed a face barely
 * 200px across, which the browser then stretched back up. Downscaling is
 * `withoutEnlargement`, so nothing here upsamples a small original: this is a
 * ceiling, and a seller who uploads a proper portrait gets a sharp one.
 */
const IMAGE_WIDTHS = { cover: 720, authorPhoto: 900, logo: 240 } as const;
const IMAGE_QUALITY = 72;

/** One product on the page: a book, or the all-books bundle. */
interface CloneProduct {
  /** Position in the offer grid; also names its cover file. */
  index: number;
  title: string;
  subtitle: string;
  priceCents: number | null;
  checkoutUrl: string | null;
  /** Storage path of its cover in the exports bucket. */
  coverPath: string | null;
  /** Deployed path once the cover has been re-encoded, e.g. `assets/cover-1.webp`. */
  coverSitePath: string | null;
  chapterTitles: string[];
  kind: 'book' | 'bundle';
  featured: boolean;
}

export interface GenerateClonedLandingPageInput {
  projectId: string;
  force?: boolean | undefined;
}

/**
 * Builds a book's sales page by filling a cloned template.
 *
 * Stages 5–7 of the clone pipeline: Claude writes prose into slots whose size
 * was measured from the template's own text, deterministic code binds it, and a
 * pixel diff against the captured template proves nothing but the content moved.
 *
 * No model call in this use case can affect layout. The copy call returns a flat
 * `Record<string, string>`; everything structural was decided during extraction
 * and is stored.
 */
export class GenerateClonedLandingPageUseCase {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly books: BookRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly channels: ChannelRepository,
    private readonly artifacts: ExportArtifactRepository,
    private readonly pages: LandingPageRepository,
    private readonly templates: LandingTemplateRepository,
    private readonly store: TemplateArtifactStore,
    private readonly binder: LandingPageBinder,
    private readonly capturer: TemplateCapturer,
    private readonly differ: PageDiffer,
    private readonly ai: AiTextGenerator,
    private readonly colors: ImageColorSampler,
    private readonly images: RemoteImageFetcher,
    private readonly imageProcessor: ImageProcessor,
    private readonly storage: ObjectStorage,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly hasher: Hasher,
  ) {}

  async execute(
    input: GenerateClonedLandingPageInput,
  ): Promise<Result<{ regenerated: boolean; fidelity: LandingFidelity }>> {
    const projectId = ProjectId.from(input.projectId);
    const project = await this.projects.findById(projectId);
    if (!project) return Result.fail('Project not found');
    if (!project.options.landingPage) return Result.fail('Landing page is not enabled for this project');
    // A 3-book page with the wrong number of books selected is a configuration
    // error. Failing here is deliberate: the alternative is rendering a
    // one-book page for someone who asked for three, which looks like the
    // request was ignored rather than like an error.
    const configError = project.options.landingConfigError();
    if (configError) return Result.fail(configError);

    const templateId = project.options.landingTemplateId;
    if (!templateId) return Result.fail('This project has no template selected');

    const template = await this.templates.findById(templateId);
    if (!template) return Result.fail('The selected template no longer exists');
    if (template.ownerId !== project.ownerId) {
      // The template id arrives from the client. Without this, anyone could
      // bind their book onto another account's cloned template.
      return Result.fail('The selected template belongs to a different account');
    }
    if (template.state !== 'READY') {
      return Result.fail(
        template.failureReason
          ? `The template is not usable: ${template.failureReason}`
          : 'The template is still being extracted',
      );
    }

    const book = await this.books.findSummaryByProject(projectId);
    if (!book) return Result.fail('Book not found');
    if (book.chapterTitles.length === 0) return Result.fail('Book has no chapters yet');
    const strategy = await this.knowledge.getBookStrategy(projectId);
    const title =
      normalizeBookTitle(book.title ?? project.options.bookTitle ?? strategy?.title ?? undefined) ?? 'Untitled';

    const now = this.clock.now();
    const existing = await this.pages.findByProject(projectId);
    const page =
      existing ?? LandingPage.create({ id: LandingPageId.from(this.ids.uuid()), projectId: input.projectId, now });

    const inputHash = this.hasher.hash({
      title,
      chapters: book.chapterTitles,
      strategy: strategy?.inputHash ?? '',
      cover: book.coverImagePath ?? '',
      price: project.options.landingPriceCents ?? null,
      compareAt: project.options.landingCompareAtCents ?? null,
      currency: project.options.landingCurrency,
      checkout: project.options.landingCheckoutUrl ?? '',
      guarantee: project.options.landingGuaranteeDays,
      // Both the template AND its revision: a re-extraction produces different
      // markup, and serving the cached page would silently ignore it.
      template: `${template.id}:${template.revision}`,
      // Every sibling's price and link. Without these, changing a sibling's
      // price would serve the cached page still advertising the old one — the
      // same reason this book's own price is in the hash.
      mode: project.options.landingMode,
      siblings: project.options.landingSiblings,
      bundlePrice: project.options.landingBundlePriceCents ?? null,
      bundleCheckout: project.options.landingBundleCheckoutUrl ?? '',
    });
    if (!input.force && existing?.inputHash === inputHash && existing.html) {
      return Result.ok({ regenerated: false, fidelity: existing.fidelity ?? emptyFidelity() });
    }

    page.markGenerating(now);
    await this.pages.saveState(page);

    const outcome = await this.build({ project, template, book, strategy, title, projectId, inputHash });
    if (outcome.isFail()) {
      page.markFailed(outcome.error, this.clock.now());
      await this.pages.saveState(page);
      return Result.fail(outcome.error);
    }

    page.setClonedDraft(
      {
        copy: outcome.value.copy,
        html: outcome.value.html,
        inputHash,
        templateId: template.id,
        binding: outcome.value.binding,
        assets: outcome.value.assets,
        fidelity: outcome.value.fidelity,
      },
      this.clock.now(),
    );
    await this.pages.save(page);
    return Result.ok({ regenerated: true, fidelity: outcome.value.fidelity });
  }

  private async build(input: {
    project: NonNullable<Awaited<ReturnType<ProjectRepository['findById']>>>;
    template: StoredLandingTemplate;
    book: NonNullable<Awaited<ReturnType<BookRepository['findSummaryByProject']>>>;
    strategy: Awaited<ReturnType<KnowledgeRepository['getBookStrategy']>>;
    title: string;
    projectId: ProjectId;
    inputHash: string;
  }): Promise<
    Result<{
      html: string;
      copy: LandingCopy;
      binding: LandingBinding;
      assets: LandingPageAsset[];
      fidelity: LandingFidelity;
    }>
  > {
    const { project, template, book, strategy, title } = input;

    const loaded = await this.store.loadTemplate(template);
    if (loaded.isFail()) return Result.fail(loaded.error);

    const channel = await this.channels.getChannel(input.projectId);
    const artifactList = await this.artifacts.listByProject(input.projectId);
    const pageCount = artifactList.find((a) => a.pageCount > 0)?.pageCount ?? null;

    // ── STAGE 5: copy ────────────────────────────────────────────────────────
    const copySlots = template.placeholders.filter((p) => isCopyKey(p.placeholder) && !splitRepeaterField(p.placeholder));

    // RECOVERY: repeater FIELDS labelled without their CONTAINER.
    //
    // The annotator can label CONTENTS_ITEMS.title / .body while the mechanical
    // container detector reports no repeating region — the observed case is a
    // card grid whose items vary enough (different bullet counts, an extra
    // utility class) that no signature reaches the coverage threshold. The
    // fields then exist with nothing to drive them: `template.repeaters` is
    // empty, so the brief below is empty, so the copy call is never ASKED for
    // those items, and every card in the grid renders blank.
    //
    // The field slots are themselves proof the region repeats, so the brief is
    // reconstructed from them. `originalCount` is unknown here — the container
    // was never measured — so it falls back to the vocabulary's own idea of a
    // sensible run, and the binder trims or pads to whatever the markup holds.
    const declared = new Set(template.repeaters.map((r) => r.key));
    const orphanedFields = new Map<string, string[]>();
    for (const p of template.placeholders) {
      const split = splitRepeaterField(p.placeholder);
      if (!split || declared.has(split.key)) continue;
      if (REPEATER_PLACEHOLDERS[split.key]?.source !== 'copy') continue;
      const fields = orphanedFields.get(split.key) ?? [];
      if (!fields.includes(split.field)) fields.push(split.field);
      orphanedFields.set(split.key, fields);
    }
    const recoveredRepeaters = [...orphanedFields.entries()].map(([key, fields]) => ({
      key,
      fields,
      // No measured container, so no measured count. The template's own grid
      // decides how many slots exist; this only has to be enough to fill it.
      originalCount: DEFAULT_REPEATER_COUNT,
      flexibleCount: true,
    }));

    const repeaterBriefs = [...template.repeaters, ...recoveredRepeaters]
      // System-rendered regions are excluded. The offer grid is built from the
      // product records below — with several different buy links on one page,
      // the model never decides which link sells which book — and testimonials
      // render only from real quotes the seller supplied.
      .filter((r) => r.fields.length > 0 && REPEATER_PLACEHOLDERS[r.key]?.source === 'copy')
      .map((r) => ({
        key: r.key,
        // The template's own count unless its container provably reflows.
        count: r.originalCount,
        fields: r.fields.map((field) => {
          const entry = template.placeholders.find((p) => p.placeholder === `${r.key}.${field}`);
          return { name: field, maxChars: entry?.maxChars ?? 120, originalText: entry?.originalText ?? '' };
        }),
      }));

    // The other books on this page, loaded BEFORE the copy is written. A
    // copywriter given only the featured book's chapters writes about that book
    // three times over — which is how a "what's inside" section came back as
    // chapter ranges 1-5, 6-10, 11-14 of one title where the template shows one
    // block per book.
    const products = await this.loadProducts({ project, book, strategy, title, projectId: input.projectId });
    if (products.isFail()) return Result.fail(products.error);

    // Audience psychology from phase 6. The landing copy has never seen it —
    // it only ever received the book strategy — and it is the one input that
    // lets a page answer an objection before it costs a sale.
    const insights = await this.knowledge.listCommentInsights(input.projectId);
    const audiencePains = unique(insights.flatMap((i) => [...i.frustrations, ...i.recurringProblems])).slice(0, 12);
    const audienceObjections = unique(insights.flatMap((i) => i.objections)).slice(0, 8);

    const written = await this.writeCopy({
      projectId: input.projectId.value,
      bookTitle: title,
      subtitle: strategy?.subtitle ?? '',
      channelTitle: channel?.title ?? 'this creator',
      author: strategy?.author,
      strategy: strategy?.toText() ?? '',
      chapterTitles: book.chapterTitles,
      pageCount,
      tone: project.options.tone,
      audiencePains: audiencePains.length > 0 ? audiencePains : undefined,
      audienceObjections: audienceObjections.length > 0 ? audienceObjections : undefined,
      slots: copySlots,
      repeaters: repeaterBriefs,
      otherBooks: products.value
        .filter((p) => !p.featured && p.kind === 'book')
        .map((p) => ({ title: p.title, chapterTitles: p.chapterTitles })),
    });
    if (written.isFail()) return Result.fail(written.error);

    // ── images become deployed files, not base64 in the row ──────────────────
    // Every book gets its OWN cover file. Sharing one between products is how a
    // page selling three books came back showing the first book three times.
    const assets: Array<{ sitePath: string; bytes: Uint8Array; contentType: string; storagePath: string }> = [];
    for (const product of products.value) {
      if (!product.coverPath) continue;
      const art = await this.loadImage(product.coverPath, IMAGE_WIDTHS.cover);
      if (!art) continue;
      product.coverSitePath = product.featured ? 'assets/cover.webp' : `assets/cover-${product.index}.webp`;
      assets.push({ ...art, sitePath: product.coverSitePath, storagePath: '' });
    }
    // {{BOOK_COVER}} always shows the FEATURED book — the one the user
    // generated from. The other books appear through the offer grid, each with
    // its own file.
    const featuredCover = products.value.find((p) => p.featured)?.coverSitePath ?? null;
    const authorPhoto = await this.loadImage(project.options.landingAuthorPhotoPath ?? null, IMAGE_WIDTHS.authorPhoto);
    if (authorPhoto) assets.push({ ...authorPhoto, sitePath: 'assets/author.webp', storagePath: '' });
    const logo = await this.loadRemoteImage(channel?.thumbnailUrl ?? null, IMAGE_WIDTHS.logo);
    if (logo) assets.push({ ...logo, sitePath: 'assets/logo.webp', storagePath: '' });

    // ── STAGE 6: bind ────────────────────────────────────────────────────────
    const coverAccent = await this.coverAccent(book.coverImagePath);
    const theme = adaptTheme({ theme: template.theme, coverAccent });

    // Stripped ONCE, then used for both the spread and the CTA fallback below.
    const writtenSlots = stripPrices(written.value.slots);

    const scalars: Record<string, string> = {
      // Model-written slots, with any currency amount REMOVED.
      //
      // The prompt forbids prices, but the model is also shown each slot's
      // original text and told to match its length — and a template whose button
      // reads "Get the Book — $37" reliably produces "Get the Book — $37" back.
      // That is the PREVIOUS seller's price sitting on a live buy button, so a
      // buyer reads $37 and is charged whatever this seller actually set. The
      // page's real prices come from {{PRICE}} / {{COMPARE_AT_PRICE}} below,
      // which are rendered from the project's own settings.
      //
      // A prompt rule alone is not enough for a defect that misstates what
      // someone will be charged, so the figure is stripped deterministically.
      ...writtenSlots,
      // A buy button with no label is a broken page, not a cosmetic gap — an
      // empty scalar binds to '' and the button renders blank. The model is
      // asked for CTA_TEXT and usually supplies it, but "usually" is not a
      // guarantee worth shipping on the one element the whole page exists to
      // get clicked.
      //
      // Reads from the STRIPPED slots, not the raw ones. Reading the raw value
      // here put the template's price straight back onto the button —
      // "Get the Book — $37" — silently undoing the strip two lines above,
      // which is exactly the defect it was added to prevent.
      CTA_TEXT: writtenSlots['CTA_TEXT']?.trim() || 'Get the book',
      BRAND_NAME: channel?.title ?? title,
      AUTHOR_NAME: strategy?.author ?? channel?.title ?? '',
      PRICE: formatMoney(project.options.landingPriceCents, project.options.landingCurrency),
      COMPARE_AT_PRICE: formatMoney(project.options.landingCompareAtCents, project.options.landingCurrency),
      GUARANTEE_DAYS: String(project.options.landingGuaranteeDays),
      ...(featuredCover ? { BOOK_COVER: featuredCover, BOOK_COVER_ALT: `${title} cover` } : {}),
      ...(authorPhoto ? { AUTHOR_IMAGE: 'assets/author.webp' } : {}),
      ...(logo ? { BRAND_LOGO: 'assets/logo.webp' } : {}),
      ...(project.options.landingCheckoutUrl ? { CHECKOUT_URL: project.options.landingCheckoutUrl } : {}),
    };

    // One card per product, each field read from ONE product record in a single
    // pass. That is what makes a buy link landing under the wrong cover
    // structurally impossible rather than merely unlikely — the same discipline
    // the built-in offer grid uses, and for the same reason.
    const repeats: Record<string, Array<Record<string, string>>> = { ...written.value.repeats };
    const hasOfferGrid = template.repeaters.some((r) => r.key === 'OFFER_ITEMS');
    // A template with no offer grid cannot sell a set: there is nowhere to put
    // the other books' prices and links, so the page would advertise three
    // books and let a buyer purchase one. Refused rather than half-rendered.
    if (!hasOfferGrid && products.value.length > 1) {
      return Result.fail(
        `This page sells ${products.value.length} products, but the template "${template.name ?? template.sourceUrl}" ` +
          'has no offer grid — no repeating region was labelled OFFER_ITEMS during extraction. Label one on the ' +
          'template, or use a template whose page sells a set.',
      );
    }
    if (hasOfferGrid) {
      repeats['OFFER_ITEMS'] = products.value.map((product) => ({
        title: product.title,
        subtitle: product.subtitle,
        price: formatMoney(product.priceCents ?? undefined, project.options.landingCurrency),
        // Missing links resolve to an inert `#` rather than an empty href, so a
        // preview before the products exist on the store still renders.
        ...(product.checkoutUrl ? { checkoutUrl: product.checkoutUrl } : {}),
        ...(product.coverSitePath ? { coverSrc: product.coverSitePath } : {}),
      }));
    }

    const binding: LandingBinding = { scalars, repeats };

    const assembled = this.binder.assemble({
      templateHtml: loaded.value.html,
      css: loaded.value.css,
      themeOverrideCss: theme.overrideCss,
      accentLiteral: theme.literalFrom && theme.accentHex ? { from: theme.literalFrom, to: theme.accentHex } : null,
      values: {
        scalars,
        repeats,
        trustedHtml: { FOOTER_LEGAL: legalMarkup(channel?.title ?? title, this.clock.now().getFullYear()) },
      },
      // The checkout URL is deliberately NOT required here: a seller previews
      // the page before the product exists on their store. Publishing is where
      // a missing link is fatal, and that gate is already in place.
      required: REQUIRED_PLACEHOLDERS.filter((key) => key !== 'CHECKOUT_URL'),
      documentTitle: written.value.slots['PAGE_TITLE'] || title,
      metaDescription: written.value.slots['META_DESCRIPTION'] || written.value.slots['HERO_SUBTITLE'] || '',
    });
    if (assembled.isFail()) return Result.fail(assembled.error.join(' · '));

    // ── STAGE 7: verify ──────────────────────────────────────────────────────
    const fidelity = await this.verify({
      html: assembled.value.html,
      template,
      assets,
      // Every product's link, not just the featured book's. On a three-book
      // page a check that only looked at the first would pass a page whose
      // other two buttons go nowhere.
      checkoutUrls: unique(
        products.value.map((product) => product.checkoutUrl ?? '').filter(Boolean),
      ),
      unresolved: assembled.value.unresolved,
      themeReason: theme.reason,
    });

    // Persist each image beside the template's own assets so the deploy can
    // read them back without re-deriving anything.
    const pageAssets: LandingPageAsset[] = [];
    for (const asset of assets) {
      const path = `pages/${input.projectId.value}/${asset.sitePath.replace('assets/', '')}`;
      const put = await this.storage.put('ebook-landing-assets', path, asset.bytes, asset.contentType);
      if (put.isOk()) {
        pageAssets.push({ sitePath: asset.sitePath, storagePath: path, contentType: asset.contentType });
      }
    }

    return Result.ok({
      html: assembled.value.html,
      copy: toLandingCopy(written.value.slots, title),
      binding,
      assets: pageAssets,
      fidelity,
    });
  }

  /**
   * Renders the bound page and proves that only the replaced content moved.
   *
   * Masked at 1280 with each placeholder's captured rect: content swapped on
   * purpose must not count as drift, or every page fails its own check. The
   * narrower widths are reported without masks and never block — masking them
   * would need an inventory pass per width, and the desktop comparison is the
   * one that catches real breakage.
   */
  private async verify(input: {
    html: string;
    template: StoredLandingTemplate;
    assets: Array<{ sitePath: string; bytes: Uint8Array; contentType: string }>;
    checkoutUrls: string[];
    unresolved: string[];
    themeReason: string;
  }): Promise<LandingFidelity> {
    const findings: Finding[] = validateBoundPage({
      html: input.html,
      checkoutUrls: input.checkoutUrls,
      sourceHost: hostOf(input.template.sourceUrl),
      expectedCtaCount: input.template.placeholders.filter((p) => p.placeholder === 'CHECKOUT_URL').length,
      // Judged here rather than at extraction: only now is the seller's own
      // price known, so a figure that is merely the copy's subject can be told
      // from one sitting where a price belongs.
      templatePrices: input.template.report?.residualPrices ?? [],
    });

    findings.push({ severity: 'INFO', code: 'THEME', message: input.themeReason });
    for (const slot of input.unresolved) {
      // A repeater field left unresolved is not one blank line — it empties
      // EVERY card in that grid, which reads as a broken page rather than a
      // missing sentence. Severity reflects that difference.
      const isRepeaterField = slot.includes('.');
      findings.push({
        severity: isRepeaterField ? 'BLOCKER' : 'WARN',
        code: isRepeaterField ? 'REPEATER_EMPTY' : 'SLOT_EMPTY',
        message: isRepeaterField
          ? `${slot} had no items, so every card in that section renders empty. The copy call did not ` +
            'return this repeater; regenerate to retry it.'
          : `${slot} had no value, so that part of the page is blank.`,
      });
    }

    const visual: LandingFidelity['visual'] = [];
    const templateAssets = await this.store.loadAssets(await this.templates.listAssets(input.template.id));
    const shot = await this.capturer.shoot({
      html: input.html,
      assets: [...templateAssets, ...input.assets],
      widths: VERIFY_WIDTHS,
    });

    if (shot.isFail()) {
      findings.push({
        severity: 'WARN',
        code: 'VERIFY_SKIPPED',
        message: `The page could not be rendered for verification: ${shot.error}`,
      });
      return { findings: findings.map(toPlain), visual, unresolvedSlots: input.unresolved };
    }

    // The captured baseline lives in storage; without it there is nothing to
    // diff against, which is a gap in the report rather than a bad page.
    const baseline = await this.loadBaseline(input.template);
    if (baseline.length === 0) {
      findings.push({
        severity: 'WARN',
        code: 'NO_BASELINE',
        message: 'The template has no stored screenshots, so the visual check could not run.',
      });
      return { findings: findings.map(toPlain), visual, unresolvedSlots: input.unresolved };
    }

    const masks: Record<number, Rect[]> = { 1280: masksFor(input.template.placeholders) };
    const compared = await this.differ.compare({ baseline, candidate: shot.value, masks });
    if (compared.isFail()) {
      findings.push({ severity: 'WARN', code: 'DIFF_FAILED', message: compared.error });
      return { findings: findings.map(toPlain), visual, unresolvedSlots: input.unresolved };
    }

    for (const result of compared.value) {
      visual.push({
        width: result.width,
        mismatchRatio: result.mismatchRatio,
        maskedMismatchRatio: result.maskedMismatchRatio,
      });

      if (result.width === 1280) {
        if (result.mismatchRatio > MAX_UNMASKED_DRIFT) {
          findings.push({
            severity: 'BLOCKER',
            code: 'LAYOUT_DRIFT',
            message:
              `${Math.round(result.mismatchRatio * 1000) / 10}% of the page changed outside the regions where ` +
              'content was replaced. The usual cause is copy longer than the box the template sized for it.',
          });
        }
        if (masks[1280] && masks[1280].length > 0 && result.maskedMismatchRatio < MIN_MASKED_CHANGE) {
          findings.push({
            severity: 'WARN',
            code: 'CONTENT_UNCHANGED',
            message:
              "The regions meant to hold this book's content barely changed. Some placeholders may have " +
              "collapsed, leaving the template's layout with holes.",
          });
        }
      } else if (result.mismatchRatio > MAX_UNMASKED_DRIFT * 4) {
        // Unmasked, so a large number here is expected — it is reported for a
        // human to glance at rather than used as a gate.
        findings.push({
          severity: 'INFO',
          code: 'NARROW_DRIFT',
          message: `At ${result.width}px the page differs from the template by ${Math.round(result.mismatchRatio * 100)}%.`,
        });
      }
    }

    return { findings: findings.map(toPlain), visual, unresolvedSlots: input.unresolved };
  }

  private async loadBaseline(template: StoredLandingTemplate) {
    const shots = [];
    for (const entry of template.baselineShots) {
      const bytes = await this.storage.getBytes('ebook-landing-assets', entry.storagePath);
      if (bytes.isFail()) continue;
      shots.push({
        width: entry.width,
        mediaType: 'image/png',
        dataBase64: bytesToBase64(bytes.value.bytes),
      });
    }
    return shots;
  }

  private async writeCopy(input: {
    projectId: string;
    bookTitle: string;
    subtitle: string;
    channelTitle: string;
    author: string | undefined;
    strategy: string;
    chapterTitles: string[];
    pageCount: number | null;
    tone: string;
    audiencePains: string[] | undefined;
    audienceObjections: string[] | undefined;
    slots: PlaceholderEntry[];
    repeaters: Array<{ key: string; count: number; fields: Array<{ name: string; maxChars: number; originalText: string }> }>;
    /** The other books on the page, with what each one actually covers. */
    otherBooks: Array<{ title: string; chapterTitles: string[] }>;
  }): Promise<Result<{ slots: Record<string, string>; repeats: Record<string, Array<Record<string, string>>> }>> {
    const prompt = TemplateCopyPrompt.build({
      ...input,
      slots: input.slots.map((s) => ({ key: s.placeholder, maxChars: s.maxChars, originalText: s.originalText })),
    });

    const completion = await this.ai.generate({
      model: 'claude-sonnet-4-6',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      // Same cliff the annotation call went over: the answer carries one value
      // per labelled slot plus every repeater item, so it scales with how
      // thoroughly the template was labelled. Hitting the ceiling fails the
      // whole generation ("the template declares more slots than the budget
      // allows") — and the better a template is labelled, the likelier it was.
      maxTokens: 32_000,
      cacheControl: { systemPrefix: true },
      metadata: { projectId: input.projectId, stage: 'landing-page-copy' },
    });
    if (completion.isFail()) return Result.fail(`Copywriting failed: ${completion.error.type}`);
    if (completion.value.stopReason === 'max_tokens') {
      return Result.fail('The copywriting response was cut off — the template declares more slots than the budget allows.');
    }

    const parsed = parseJsonCompletion(completion.value.text, CopyResponseSchema);
    if (parsed.isFail()) return Result.fail(parsed.error);

    // Trim to the measured budget rather than failing. The template's CSS is
    // what enforces the length; a slot four characters over is a clipped word,
    // not a reason to lose the whole page.
    const slots: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.value.slots)) {
      const budget = input.slots.find((s) => s.placeholder === key)?.maxChars;
      slots[key] = budget && value.length > budget ? `${value.slice(0, budget - 1).trimEnd()}…` : value;
    }

    // A repeater the model skipped is not a missing sentence — it is a whole
    // grid of cards rendering with empty headings, which is what a reader sees
    // as a broken page. The schema defaults `repeats` to {}, so an omission is
    // silent; ask once more for exactly the keys that came back missing rather
    // than shipping the hole.
    //
    // "Usable" is per FIELD, not per key. The observed failure was not an
    // omitted repeater at all: FAQ_ITEMS came back with items, so this retry
    // never fired, but the items carried no `question`/`answer` values — and an
    // item with no fields renders exactly the empty card an omitted repeater
    // would. bindTemplate reports those as `FAQ_ITEMS.question`, with the field
    // suffix, which is how the two are told apart.
    const usableItems = (key: string, fields: Array<{ name: string }>) =>
      (parsed.value.repeats[key] ?? []).filter((item) =>
        fields.some((f) => typeof item[f.name] === 'string' && item[f.name] !== ''),
      );
    const missing = input.repeaters.filter((r) => usableItems(r.key, r.fields).length === 0);
    if (missing.length > 0) {
      const retryPrompt = TemplateCopyPrompt.build({
        ...input,
        slots: [],
        repeaters: missing,
      });
      const retry = await this.ai.generate({
        model: 'claude-sonnet-4-6',
        system: retryPrompt.system,
        messages: [{ role: 'user', content: retryPrompt.user }],
        maxTokens: 16_000,
        cacheControl: { systemPrefix: true },
        metadata: { projectId: input.projectId, stage: 'landing-page-copy-repeats' },
      });
      if (retry.isOk()) {
        const reparsed = parseJsonCompletion(retry.value.text, CopyResponseSchema);
        if (reparsed.isOk()) {
          for (const r of missing) {
            const items = reparsed.value.repeats[r.key];
            // Accepted only if the retry's items actually carry the fields. An
            // item shaped like the last one replaces a broken grid with an
            // identically broken one, and hides that the retry achieved nothing.
            if (
              items &&
              items.some((item) => r.fields.some((f) => typeof item[f.name] === 'string' && item[f.name] !== ''))
            ) {
              parsed.value.repeats[r.key] = items;
            }
          }
        }
      }
      // Whatever survives, no card renders half-empty. An item carrying none of
      // its fields is dropped, and a repeater left with nothing is dropped
      // whole — bindTemplate then REMOVES that region instead of cloning blanks
      // into it, so the page comes up a section short rather than showing a
      // grid of empty cards, which is what a reader reads as broken.
      for (const r of input.repeaters) {
        const usable = usableItems(r.key, r.fields);
        if (usable.length > 0) parsed.value.repeats[r.key] = usable;
        else delete parsed.value.repeats[r.key];
      }
      // Still missing after the retry is a real defect, but a page with one
      // empty grid still beats no page at all — bindTemplate reports the
      // unresolved keys and the fidelity report surfaces them.
    }

    return Result.ok({ slots, repeats: parsed.value.repeats });
  }

  /**
   * Every product this page sells: the featured book, its siblings, and the
   * bundle when the seller has set one up.
   *
   * A sibling that cannot be loaded fails the whole generation rather than
   * being skipped. The user asked for a page selling three specific books;
   * silently publishing one that sells two is wrong in a way nobody notices
   * until a reader cannot buy the book the page promised.
   */
  private async loadProducts(input: {
    project: NonNullable<Awaited<ReturnType<ProjectRepository['findById']>>>;
    book: NonNullable<Awaited<ReturnType<BookRepository['findSummaryByProject']>>>;
    strategy: Awaited<ReturnType<KnowledgeRepository['getBookStrategy']>>;
    title: string;
    projectId: ProjectId;
  }): Promise<Result<CloneProduct[]>> {
    const { project } = input;
    const products: CloneProduct[] = [
      {
        index: 0,
        title: input.title,
        subtitle: input.strategy?.subtitle ?? '',
        priceCents: project.options.landingPriceCents ?? null,
        checkoutUrl: project.options.landingCheckoutUrl ?? null,
        coverPath: input.book.coverImagePath,
        coverSitePath: null,
        chapterTitles: input.book.chapterTitles,
        kind: 'book',
        // The book the user came from leads the page.
        featured: true,
      },
    ];

    for (const [i, sibling] of project.options.landingSiblings.entries()) {
      const siblingId = ProjectId.from(sibling.projectId);
      const siblingProject = await this.projects.findById(siblingId);
      if (!siblingProject) return Result.fail(`Selected book ${sibling.projectId} no longer exists`);
      // A security boundary, not a sanity check: the sibling project id arrives
      // from the client, so without this anyone could put someone else's book —
      // cover, title and all — on their own sales page.
      if (siblingProject.ownerId !== project.ownerId) {
        return Result.fail(`Selected book ${sibling.projectId} belongs to a different account`);
      }

      const siblingBook = await this.books.findSummaryByProject(siblingId);
      if (!siblingBook || !siblingBook.hasChapters) {
        return Result.fail(`Selected book ${sibling.projectId} is not finished yet`);
      }
      const siblingStrategy = await this.knowledge.getBookStrategy(siblingId);
      const siblingCommerceValues = siblingCommerce(siblingProject.options, sibling);

      products.push({
        index: i + 1,
        title:
          normalizeBookTitle(
            siblingBook.title ?? siblingProject.options.bookTitle ?? siblingStrategy?.title ?? undefined,
          ) ?? 'Untitled',
        subtitle: siblingStrategy?.subtitle ?? '',
        // Price and link follow THE BOOK, falling back to whatever this page
        // recorded for it — see siblingCommerce. Resolved identically to the
        // built-in renderer on purpose: the two engines disagreeing about what
        // a book costs would be a bug nobody could reproduce, because which one
        // runs depends on whether the project has a cloned template.
        priceCents: siblingCommerceValues.priceCents,
        checkoutUrl: siblingCommerceValues.checkoutUrl,
        coverPath: siblingBook.coverImagePath,
        coverSitePath: null,
        chapterTitles: siblingBook.chapterTitles,
        kind: 'book',
        featured: false,
      });
    }

    const bundle = this.buildBundle(project.options, products);
    if (bundle) products.push(bundle);

    return Result.ok(products);
  }

  /**
   * The all-books bundle, when the seller has set one up. It is a real product
   * on their store with its own link, so it exists only when that link or price
   * was supplied — never synthesised to fill out the grid.
   */
  private buildBundle(
    options: { landingBundlePriceCents?: number | undefined; landingBundleCheckoutUrl?: string | undefined },
    books: CloneProduct[],
  ): CloneProduct | null {
    if (options.landingBundlePriceCents === undefined && !options.landingBundleCheckoutUrl) return null;
    if (books.length < 2) return null; // a "bundle" of one book is just the book
    return {
      index: books.length,
      title: `The complete set — all ${books.length} books`,
      subtitle: 'Every book above, in one purchase.',
      priceCents: options.landingBundlePriceCents ?? null,
      checkoutUrl: options.landingBundleCheckoutUrl ?? null,
      // No cover of its own; the card shows its title and price.
      coverPath: null,
      coverSitePath: null,
      chapterTitles: [],
      kind: 'bundle',
      featured: false,
    };
  }

  private async loadImage(
    path: string | null | undefined,
    maxWidth: number,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (!path) return null;
    const raw = await this.storage.getBytes(EXPORTS_BUCKET, path);
    if (raw.isFail()) return null;
    const processed = await this.imageProcessor.downscaleToBytes({
      bytes: raw.value.bytes,
      maxWidth,
      quality: IMAGE_QUALITY,
    });
    return processed.isOk() ? processed.value : null;
  }

  private async loadRemoteImage(
    url: string | null,
    maxWidth: number,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (!url) return null;
    const fetched = await this.images.fetchBytes(url);
    if (fetched.isFail()) return null;
    const processed = await this.imageProcessor.downscaleToBytes({
      bytes: fetched.value.bytes,
      maxWidth,
      quality: IMAGE_QUALITY,
    });
    return processed.isOk() ? processed.value : null;
  }

  private async coverAccent(path: string | null) {
    if (!path) return null;
    const raw = await this.storage.getBytes(EXPORTS_BUCKET, path);
    if (raw.isFail()) return null;
    const sampled = await this.colors.dominantColor(raw.value.bytes);
    return sampled.isOk() ? sampled.value : null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function masksFor(placeholders: PlaceholderEntry[]): Rect[] {
  return placeholders
    .map((p) => p.rect)
    .filter((rect): rect is Rect => rect !== undefined && rect.width > 0 && rect.height > 0);
}

function toPlain(finding: Finding) {
  return { severity: finding.severity, code: finding.code, message: finding.message };
}

function emptyFidelity(): LandingFidelity {
  return { findings: [], visual: [], unresolvedSlots: [] };
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$' };

/**
 * Slots where a stray currency amount is DANGEROUS rather than merely untidy.
 *
 * A buy button is the case that matters: "Get the Book — $37" beside a checkout
 * that charges $20 tells the buyer a price they will not be charged. These slots
 * are short labels, so removing a trailing "— $37" leaves a clean, sensible
 * string ("Get the Book").
 *
 * Prose slots are deliberately NOT in this list. Cutting "$57" out of "reduced
 * from $57 to $37" yields "reduced from to ." — ungrammatical text is a worse
 * defect than the one being fixed, and prose prices are already caught by the
 * templateContract check, which reports them for a human to resolve.
 */
const PRICE_UNSAFE_SLOTS = new Set(['CTA_TEXT', 'PROMO_LINE', 'BADGE_TEXT']);

/**
 * Removes currency amounts from the short label slots above.
 *
 * The page's real prices come from {{PRICE}} / {{COMPARE_AT_PRICE}}, rendered by
 * the system from the project's own settings. A figure in a model-written label
 * is the PREVIOUS seller's price copied out of the template's original text.
 *
 * Matches a currency SYMBOL followed by digits ("$37", "£19.99", "€47") — bare
 * numbers are left alone, because "101 secrets" and "90 days" are content.
 */
function stripPrices(slots: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...slots };
  for (const key of PRICE_UNSAFE_SLOTS) {
    const value = out[key];
    if (typeof value !== 'string' || !/[$£€]\s?\d/.test(value)) continue;
    const cleaned = value
      .replace(/[$£€]\s?\d[\d,]*(\.\d{2})?/g, '')
      // Tidy the join the removal left behind: "Get the Book — " → "Get the Book".
      .replace(/\s*[—–-]\s*$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // Never leave the button blank — that is a worse failure than a wrong price.
    if (cleaned) out[key] = cleaned;
  }
  return out;
}

function formatMoney(cents: number | undefined, currency: string): string {
  if (cents === undefined) return '';
  const amount = cents / 100;
  const text = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${text}` : `${text} ${currency.toUpperCase()}`;
}

/**
 * The disclaimer, system-rendered.
 *
 * Never the template's own: cloning the owner's refund policy would publish a
 * contractual claim the seller never made, on a page taking their money.
 */
function legalMarkup(siteName: string, year: number): string {
  const safe = siteName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    `<p>© ${year} ${safe}. All rights reserved.</p>` +
    `<p>This is a digital product delivered as a downloadable file; nothing is shipped. ` +
    `Any figures shown are illustrative and not a guarantee — individual results vary.</p>`
  );
}

/**
 * The subset of `LandingCopy` a cloned page has.
 *
 * Most of that interface describes the built-in renderer's fixed sections,
 * which a cloned page does not have — its sections are the template's. Filled
 * so the existing row shape and preview endpoint keep working unchanged.
 */
function toLandingCopy(slots: Record<string, string>, title: string): LandingCopy {
  return {
    headline: slots['HERO_TITLE'] ?? title,
    subheadline: slots['HERO_SUBTITLE'] ?? '',
    eyebrow: '',
    ctaLabel: slots['CTA_TEXT'] ?? 'Get the book',
    painPoints: [],
    whatsInsideHeading: '',
    bullets: [],
    whoIsItForHeading: '',
    whoIsItFor: [],
    authorHeading: '',
    authorBio: slots['AUTHOR_BIO'] ?? '',
    faqs: [],
    categoryLabel: '',
    productFeatures: [],
    comparisonWithout: [],
    comparisonWith: [],
    closingHeading: '',
    closingBody: '',
    fontFamily: 'sans',
    templateSections: [],
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Base64 without Node's Buffer, so this file stays framework-free. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}
