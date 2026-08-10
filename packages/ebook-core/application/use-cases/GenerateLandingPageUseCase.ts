import { z } from 'zod';
import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { LandingPage, LandingPageId, type LandingCopy } from '../../domain/landing/LandingPage';
import { normalizeBookTitle, type LandingMode } from '../../domain/project/GenerationOptions';
import { Palette, parseHexColor } from '../../domain/landing/Palette';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { KnowledgeRepository } from '../ports/repositories/KnowledgeRepository';
import type { ChannelRepository } from '../ports/repositories/ChannelRepository';
import type { ExportArtifactRepository } from '../ports/repositories/ExportArtifactRepository';
import type { LandingPageRepository } from '../ports/repositories/LandingPageRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { ImageColorSampler } from '../ports/services/ImageColorSampler';
import type { RemoteImageFetcher } from '../ports/services/RemoteImageFetcher';
import type { ImageProcessor } from '../ports/services/ImageProcessor';
import type { LandingPageRenderer, LandingProduct } from '../ports/services/LandingPageRenderer';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { IdGenerator } from '../ports/IdGenerator';
import type { Clock } from '../ports/Clock';
import type { Hasher } from '../ports/Hasher';
import { LandingPagePrompt, LandingSlotCopyPrompt } from '../prompts/LandingPagePrompt';
import { LandingLayoutPrompt } from '../prompts/LandingLayoutPrompt';
import { LayoutReviewPrompt } from '../prompts/LayoutReviewPrompt';
import { parseJsonCompletion } from '../prompts/parse';
import { validateGeneratedPage, fillCopySlots, type GeneratedPage } from '../landing/pageContract';
import type { LandingPageAssembler } from '../ports/services/LandingPageAssembler';
import type { ReferencePage, ReferencePageFetcher } from '../ports/services/ReferencePageFetcher';
import type { ReferenceScreenshotter, ReferenceShot } from '../ports/services/ReferenceScreenshotter';
import type { WebFontFetcher } from '../ports/services/WebFontFetcher';
import { referenceUrlFor } from '../../domain/landing/LandingTemplate';
import { preferredStackFor } from '../../domain/landing/fontStacks';
import type {
  LandingLayoutRepository,
  StoredLandingLayout,
} from '../ports/repositories/LandingLayoutRepository';

const LayoutSchema = z.object({
  css: z.string(),
  bodyHtml: z.string(),
  // Declared by the layout call so the copy call knows what to write. Defaulted
  // rather than required so a malformed response is reported by the contract's
  // slot check, which explains the problem, instead of by a schema error.
  slots: z
    .array(z.object({ key: z.string(), purpose: z.string().default(''), maxChars: z.number().default(120) }))
    .default([]),
});

/** The bucket the cover art and exports already live in. */
const EXPORTS_BUCKET = 'ebook-exports';

/**
 * Widths every inlined image is resized to before it becomes a data URI, in
 * device pixels — roughly 2× the CSS width each one is displayed at, so the
 * page still looks sharp on a retina screen.
 *
 * These exist because the page carries its images INSIDE its HTML, and that HTML
 * is a single Postgres column written in a single PostgREST request. Cover art
 * arrives from gpt-image-1 at 1024×1536 (~3MB PNG, ~4MB once base64'd) and a
 * three-book page embeds eight or so of them — which is how the whole write grew
 * past both the statement timeout and the gateway's tolerance, and started
 * failing as a Postgres 57014 on one attempt and a Cloudflare 502 on the next.
 * At these widths the same page is a few hundred KB.
 */
const INLINE_WIDTHS = { cover: 720, authorPhoto: 400, logo: 240 } as const;

/** Re-encode quality for inlined images. 72 is visually clean for WebP. */
const INLINE_QUALITY = 72;

/**
 * The stat row under the hero, built ONLY from facts already in the system.
 * The reference sales pages show things like "4,200+ owners reading" — a real
 * figure their owner can stand behind. We have no such number, and inventing
 * one would be a false claim about real customers, so each stat renders only
 * when its source exists.
 */
function buildStats(input: {
  pageCount: number | null;
  subscriberCount: number | null;
  guaranteeDays: number;
}): Array<{ value: string; label: string }> {
  const stats: Array<{ value: string; label: string }> = [];
  if (input.pageCount && input.pageCount > 0) {
    stats.push({ value: String(input.pageCount), label: 'Pages' });
  }
  if (input.subscriberCount && input.subscriberCount >= 1000) {
    stats.push({ value: compactCount(input.subscriberCount), label: 'Subscribers' });
  }
  if (input.guaranteeDays > 0) {
    stats.push({ value: String(input.guaranteeDays), label: 'Day guarantee' });
  }
  // One lonely stat looks like an oversight; show the row only once it's a row.
  return stats.length >= 2 ? stats : [];
}

function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  return `${Math.round(n / 1000)}K`;
}

/**
 * The reference's structure as headings plus a sample of what sits under each.
 *
 * The heading alone says too little — "The Math" or "Choose Your Level" does not
 * tell the copywriter what belongs there. The text beneath it does, which is why
 * each entry carries an excerpt: the copy call is being asked to cover the same
 * GROUND for our book, not to reproduce the words.
 *
 * Top-level headings only. A reference's h3s are usually the items inside a
 * section (individual cards, individual FAQs), and treating those as sections
 * would produce dozens of one-line stubs.
 */
function outlineOf(reference: ReferencePage): Array<{ heading: string; excerpt: string }> {
  const structural = reference.headings.filter((h) => h.level <= 2);
  const candidates = structural.length >= 3 ? structural : reference.headings;
  const text = reference.text;

  // Deduplicated and capped: every section costs output tokens in the copy
  // call, and running past that ceiling returns truncated JSON rather than an
  // error. Ten covers a long sales page; a reference with more than that is
  // repeating itself, which duplicate headings usually confirm.
  const seen = new Set<string>();
  const headings = candidates
    .filter((h) => {
      const key = h.text.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 10);

  return headings.map((h, i) => {
    const start = text.indexOf(h.text);
    if (start === -1) return { heading: h.text, excerpt: '(no visible text captured)' };
    const after = start + h.text.length;
    // Up to the next heading, so an excerpt never bleeds into the following
    // section and mislabels what this one is for.
    const nextHeading = headings[i + 1]?.text;
    const nextAt = nextHeading ? text.indexOf(nextHeading, after) : -1;
    const end = nextAt === -1 ? after + 320 : Math.min(nextAt, after + 320);
    const excerpt = text.slice(after, end).trim();
    return { heading: h.text, excerpt: excerpt || '(heading only)' };
  });
}

/**
 * Filler text for a layout review, sized to each slot's own ceiling.
 *
 * Realistic LENGTH is the whole point: a slot filled with "text" tells you
 * nothing about whether its column can hold a sentence, and the defects worth
 * catching — two-word wrapping, clipped headings — only appear at full length.
 */
function fillerFor(slots: Array<{ key: string; maxChars: number }>): Record<string, string> {
  const words =
    'the quote you were given covers parts labour and a diagnostic fee that any owner can read in a driveway with a cheap scanner before agreeing to anything at all'.split(
      ' ',
    );
  const out: Record<string, string> = {};
  for (const slot of slots) {
    // 85% of the ceiling: long enough to stress the column, short enough that
    // an overflow in the shot is the layout's fault and not the filler's.
    const target = Math.max(4, Math.floor(slot.maxChars * 0.85));
    let text = '';
    for (let i = 0; text.length < target; i++) {
      const next = words[i % words.length] as string;
      if (text.length + next.length + 1 > target) break;
      text = text ? `${text} ${next}` : next;
    }
    out[slot.key] = text.charAt(0).toUpperCase() + text.slice(1);
  }
  return out;
}

/**
 * A stand-in page model for reviewing a layout before any book is attached.
 * Every figure is obviously synthetic — this render is never shown to a buyer,
 * it only goes to the reviewer as an image.
 */
/**
 * Stand-in artwork for the visual review, so the reviewer judges the LAYOUT and
 * not the fixture. Flat SVG rather than a real photograph: it fills the slot at
 * the right aspect ratio and is obviously a placeholder, which is what the
 * reviewer needs to tell "the cover sits badly here" from "there is no cover".
 */
const PREVIEW_COVER =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MDAgNjAwIj48cmVjdCB3aWR0aD0iNDAwIiBoZWlnaHQ9IjYwMCIgZmlsbD0iIzFkMjczMyIvPjxyZWN0IHg9IjI2IiB5PSIzNCIgd2lkdGg9IjM0OCIgaGVpZ2h0PSI1MzIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2M5Yjk4ZCIgc3Ryb2tlLXdpZHRoPSIyIi8+PHRleHQgeD0iMjAwIiB5PSIyOTAiIGZvbnQtZmFtaWx5PSJHZW9yZ2lhLHNlcmlmIiBmb250LXNpemU9IjM4IiBmaWxsPSIjZWFkOWI0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5QUkVWSUVXPC90ZXh0Pjx0ZXh0IHg9IjIwMCIgeT0iMzMwIiBmb250LWZhbWlseT0iR2VvcmdpYSxzZXJpZiIgZm9udC1zaXplPSIyMCIgZmlsbD0iIzlmYjBjNCIgdGV4dC1hbmNob3I9Im1pZGRsZSI+Q09WRVI8L3RleHQ+PC9zdmc+';
const PREVIEW_PHOTO =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MDAgNTAwIj48cmVjdCB3aWR0aD0iNDAwIiBoZWlnaHQ9IjUwMCIgZmlsbD0iIzViNjQ3MiIvPjxjaXJjbGUgY3g9IjIwMCIgY3k9IjE5MCIgcj0iNzgiIGZpbGw9IiM4ZDk3YTYiLz48cGF0aCBkPSJNNjAgNTAwYzAtODggNjMtMTUwIDE0MC0xNTBzMTQwIDYyIDE0MCAxNTB6IiBmaWxsPSIjOGQ5N2E2Ii8+PC9zdmc+';
const PREVIEW_LOGO =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiI+PGNpcmNsZSBjeD0iNDgiIGN5PSI0OCIgcj0iNDgiIGZpbGw9IiNjOWI5OGQiLz48dGV4dCB4PSI0OCIgeT0iNjIiIGZvbnQtZmFtaWx5PSJHZW9yZ2lhLHNlcmlmIiBmb250LXNpemU9IjQyIiBmaWxsPSIjMWQyNzMzIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5QPC90ZXh0Pjwvc3ZnPg==';

/**
 * The page the visual reviewer looks at.
 *
 * `has` MUST mirror what the layout call was told, because the reviewer's only
 * job is to spot a broken layout. Reviewing a fixed all-null fixture meant a
 * layout was told "a portrait is available, place it", placed it, and was then
 * judged on a render where it did not exist — so the empty frame came back as
 * "a large image placeholder, mostly blank, creating an unfilled region" and
 * the layout was rejected for a defect the real page would never have.
 */
function previewModel(has: { authorPhoto: boolean; logo: boolean }): Parameters<LandingPageRenderer['render']>[0] {
  const product: LandingProduct = {
    title: 'Preview Title',
    subtitle: 'Preview subtitle',
    // Every book reaching this point has cover art, and {{COVER}} is always
    // available to a layout — so an empty cover slot is never what ships.
    coverDataUri: PREVIEW_COVER,
    pageCount: 120,
    categoryLabel: 'Preview',
    features: ['Preview feature one', 'Preview feature two', 'Preview feature three'],
    contents: ['Preview chapter one', 'Preview chapter two'],
    sections: [{ title: 'Preview section', items: ['Preview point one', 'Preview point two'] }],
    priceCents: 2700,
    compareAtCents: 7900,
    checkoutUrl: 'https://example.com/preview',
    kind: 'book',
    featured: true,
  };
  return {
    copy: {
      headline: 'Preview headline',
      subheadline: 'Preview subheadline',
      eyebrow: 'Preview',
      ctaLabel: 'Get the book',
      painPoints: [],
      whatsInsideHeading: '',
      bullets: [],
      whoIsItForHeading: '',
      whoIsItFor: [],
      authorHeading: '',
      authorBio: '',
      faqs: [],
      categoryLabel: 'Preview',
      productFeatures: product.features,
      comparisonWithout: [],
      comparisonWith: [],
      closingHeading: '',
      closingBody: '',
      fontFamily: 'sans',
      templateSections: [],
    },
    palette: Palette.neutral(),
    currency: 'USD',
    guaranteeDays: 30,
    author: 'Preview Author',
    channelTitle: 'Preview Channel',
    subscriberCount: 100_000,
    testimonials: [],
    products: [product],
    siteName: 'Preview',
    logoDataUri: has.logo ? PREVIEW_LOGO : null,
    stats: [
      { value: '120', label: 'Pages' },
      { value: '30', label: 'Day guarantee' },
    ],
    heroImageDataUri: null,
    // Still null when this project has no portrait — a layout that only looks
    // right WITH one must not pass review. But when the layout call was TOLD a
    // portrait exists, reviewing without it judges the wrong page.
    authorPhotoDataUri: has.authorPhoto ? PREVIEW_PHOTO : null,
    authorCredential: 'Preview Author · Preview Channel',
    promoEndsAt: null,
    rating: null,
    valueStack: [],
    costComparison: null,
    paymentMethods: [],
    edition: 'MMXXVI · No. I',
  };
}

/** Roman numeral year for the footer's edition line, e.g. 2026 → "MMXXVI". */
function romanYear(year: number): string {
  const table: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let n = year;
  let out = '';
  for (const [value, sym] of table) {
    while (n >= value) {
      out += sym;
      n -= value;
    }
  }
  return out;
}

/** "Adrian · Car Care Garage" — both halves are real, so both are optional. */
function buildCredential(author: string | undefined, channelTitle: string | null): string | null {
  const parts = [author, channelTitle].filter((p): p is string => Boolean(p && p.trim()));
  // Avoid "Car Care Garage · Car Care Garage" when the byline IS the channel.
  const unique = [...new Set(parts)];
  return unique.length > 0 ? unique.join(' · ') : null;
}

const CopySchema = z.object({
  eyebrow: z.string(),
  headline: z.string(),
  subheadline: z.string(),
  ctaLabel: z.string(),
  painPoints: z.array(z.string()).default([]),
  whatsInsideHeading: z.string(),
  bullets: z.array(z.object({ title: z.string(), body: z.string() })).min(1),
  whoIsItForHeading: z.string(),
  whoIsItFor: z.array(z.string()).default([]),
  authorHeading: z.string(),
  authorBio: z.string(),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  categoryLabel: z.string().default(''),
  productFeatures: z.array(z.string()).default([]),
  comparisonWithout: z.array(z.string()).default([]),
  comparisonWith: z.array(z.string()).default([]),
  // Defaulted like their neighbours, and for the same reason. These two sit
  // second-from-last in the prompt's key list and are the two the model most
  // often decides are redundant — a page that already closes with a price and
  // a button. Left required, that judgement call failed the whole generation
  // on a schema error, and the retry made the same call again. Both renderers
  // omit the section when it is empty, so absent copy costs a closing line,
  // not a page.
  closingHeading: z.string().default(''),
  closingBody: z.string().default(''),
  // ── direct-response sections ──
  // All defaulted, like their neighbours above and for the same reason: a model
  // that judges one of these redundant must cost a section, not the whole page.
  // Every renderer omits its section when the field is empty.
  failedAlternatives: z.array(z.string()).default([]),
  discoveryHeading: z.string().default(''),
  discoveryStory: z.string().default(''),
  fascinationsHeading: z.string().default(''),
  fascinations: z
    .array(
      z.object({
        text: z.string(),
        // Tolerant of the model returning a string ("4") or omitting it: this is
        // decoration on a curiosity line, never worth failing a generation over.
        chapter: z.coerce.number().int().positive().nullable().catch(null).default(null),
      }),
    )
    .default([]),
  notForHeading: z.string().default(''),
  notFor: z.array(z.string()).default([]),
  postscripts: z.array(z.string()).default([]),
  fontFamily: z.enum(['serif', 'sans']).default('sans'),
  // One entry per reference section, so the page can follow the whole template
  // rather than only the parts the fixed fields above happen to cover.
  templateSections: z
    .array(
      z.object({
        heading: z.string(),
        eyebrow: z.string().default(''),
        intro: z.string().default(''),
        kind: z.enum(['prose', 'cards', 'list', 'steps', 'comparison', 'table']).default('prose'),
        items: z.array(z.object({ title: z.string(), body: z.string() })).default([]),
        table: z
          .object({
            leftHeading: z.string(),
            rightHeading: z.string(),
            rows: z.array(z.object({ label: z.string(), left: z.string(), right: z.string() })),
            leftTotal: z.string().default(''),
            rightTotal: z.string().default(''),
            // Required by the schema, not optional: a figure table with no
            // stated origin is the riskiest thing that can go on this page.
            source: z.string(),
          })
          .nullable()
          .default(null),
      }),
    )
    .default([]),
});

export interface GenerateLandingPageInput {
  projectId: string;
  /** Rebuild even when the inputs are unchanged (the user pressed Regenerate). */
  force?: boolean;
  /**
   * Re-derive the stored layout for this template instead of reusing it. The
   * cache is what keeps pages identical, so re-deriving is an explicit act.
   */
  rebuildLayout?: boolean;
}

/**
 * Builds the sales page for a finished book: Claude writes the copy, the palette
 * is derived from the book's own cover art, and a fixed template renders both
 * into one self-contained HTML document, stored as a DRAFT.
 *
 * Publishing is a separate, explicitly-triggered step — see
 * PublishLandingPageUseCase.
 */
export class GenerateLandingPageUseCase {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly books: BookRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly channels: ChannelRepository,
    private readonly artifacts: ExportArtifactRepository,
    private readonly pages: LandingPageRepository,
    private readonly layouts: LandingLayoutRepository,
    private readonly ai: AiTextGenerator,
    private readonly renderer: LandingPageRenderer,
    private readonly assembler: LandingPageAssembler,
    private readonly references: ReferencePageFetcher,
    private readonly screenshots: ReferenceScreenshotter,
    private readonly fonts: WebFontFetcher,
    private readonly colors: ImageColorSampler,
    private readonly images: RemoteImageFetcher,
    private readonly imageProcessor: ImageProcessor,
    private readonly storage: ObjectStorage,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly hasher: Hasher,
  ) {}

  /**
   * Why the last layout derivation failed, if it did. Held on the instance
   * rather than threaded through every return type: it is diagnostic output
   * for one call, and the use case is constructed per request.
   */
  private lastLayoutFailure: string[] | undefined;

  /**
   * Visual complaints on a layout that was ACCEPTED anyway — it passed every
   * mechanical check, and the built-in template would have been worse. Reported
   * rather than swallowed, so a real defect is still findable.
   */
  private lastVisualNotes: string[] | undefined;

  async execute(
    input: GenerateLandingPageInput,
  ): Promise<
    Result<{
      regenerated: boolean;
      layout?: 'generated' | 'builtin';
      layoutFailure?: string[];
      /** The reference actually used, after mode routing. */
      referenceUrl?: string | null;
      /** How many reference screenshots reached the layout call. 0 = markup only. */
      screenshots?: number;
      /** Why the reference is thinner than expected, when it is. */
      referenceNote?: string;
      /** Visual complaints on a layout that shipped anyway. */
      visualNotes?: string[];
    }>
  > {
    const projectId = ProjectId.from(input.projectId);
    const project = await this.projects.findById(projectId);
    if (!project) return Result.fail('Project not found');
    if (!project.options.landingPage) return Result.fail('Landing page is not enabled for this project');
    // A 3-ebook page with the wrong number of books selected is a configuration
    // error. Failing here is deliberate: the alternative is rendering a
    // single-book page for someone who asked for three, which looks like the
    // request was ignored rather than like an error.
    const configError = project.options.landingConfigError();
    if (configError) return Result.fail(configError);

    // Summary, not the whole aggregate: this use case reads four fields and no
    // chapter prose, and loading the full book three times over on a three-book
    // page is what exceeded the database's statement timeout.
    const book = await this.books.findSummaryByProject(projectId);
    if (!book) return Result.fail('Book not found');
    const strategy = await this.knowledge.getBookStrategy(projectId);
    // Older projects stored the title in raw filename form; normalize on the
    // way out so the page never shows THE_DIY_REPAIR_BIBLE_… in its masthead.
    const title =
      normalizeBookTitle(book.title ?? project.options.bookTitle ?? strategy?.title ?? undefined) ?? 'Untitled';
    const chapterTitles = book.chapterTitles;
    if (chapterTitles.length === 0) return Result.fail('Book has no chapters yet');

    const now = this.clock.now();
    const existing = await this.pages.findByProject(projectId);
    const page =
      existing ?? LandingPage.create({ id: LandingPageId.from(this.ids.uuid()), projectId: input.projectId, now });

    // Everything the page is derived from. Prices and the checkout URL are in
    // here too: changing the price must rebuild the page, or the buttons keep
    // advertising the old one.
    const inputHash = this.hasher.hash({
      title,
      chapters: chapterTitles,
      strategy: strategy?.inputHash ?? '',
      cover: book.coverImagePath ?? '',
      price: project.options.landingPriceCents ?? null,
      compareAt: project.options.landingCompareAtCents ?? null,
      currency: project.options.landingCurrency,
      checkout: project.options.landingCheckoutUrl ?? '',
      guarantee: project.options.landingGuaranteeDays,
      // Pointing the book at a different reference must rebuild the layout.
      template: referenceUrlFor(project.options.landingMode, project.options.landingTemplateUrl) ?? '',
      // Mode and every sibling's price and link. Without these, changing a
      // sibling's price would serve the cached page still advertising the old
      // one — the same reason this book's own price is in the hash.
      mode: project.options.landingMode,
      siblings: project.options.landingSiblings,
      bundlePrice: project.options.landingBundlePriceCents ?? null,
      bundleCheckout: project.options.landingBundleCheckoutUrl ?? '',
    });
    if (!input.force && existing?.inputHash === inputHash && existing.html) {
      return Result.ok({ regenerated: false }); // idempotent — nothing has changed
    }

    page.markGenerating(now);
    // State only: a full save would rewrite the existing multi-megabyte html
    // just to flip an enum, and that is what exceeded the statement timeout.
    await this.pages.saveState(page);

    // ── the reference page this book's layout should follow ──
    // Which reference depends on the MODE, not on the project: a three-book
    // page always follows the three-book template.
    const referenceUrl = referenceUrlFor(project.options.landingMode, project.options.landingTemplateUrl);

    // Strictly best-effort: the reference is someone else's live site and may
    // be down, slow or blocking us. A book still gets a landing page.
    let reference: ReferencePage | null = null;
    let referenceShots: ReferenceShot[] = [];
    // Why the reference ended up as it did. Both steps degrade silently by
    // design, which means without this nobody can tell a high-fidelity run from
    // one that quietly worked off markup alone — the difference that decides
    // whether the output is worth showing anyone.
    let referenceNote: string | undefined;
    if (referenceUrl) {
      const fetched = await this.references.fetch(referenceUrl);
      if (fetched.isOk()) reference = fetched.value;
      else referenceNote = `reference fetch failed: ${fetched.error}`;

      // The screenshots are what carry spacing and visual rhythm; the markup
      // alone only carries structure. Also best-effort — a site that blocks
      // automation costs fidelity, never the page itself.
      const shot = await this.screenshots.capture(referenceUrl);
      if (shot.isOk()) referenceShots = shot.value;
      else referenceNote = [referenceNote, `screenshots failed: ${shot.error}`].filter(Boolean).join('; ');
    }

    // ── palette, from the book's own cover ──
    const cover = await this.loadCover(book.coverImagePath);
    // The client's spec is "copy the template, change the branding/colours to
    // the ebook": the reference contributes the LAYOUT, the book's own cover
    // contributes the COLOURS. The reference's detected accent is used only
    // when the book has no readable cover to derive a scheme from.
    const referenceAccent = parseHexColor(reference?.style.accent) ?? undefined;
    const palette = cover.seed
      ? Palette.fromSeed(cover.seed)
      : referenceAccent
        ? Palette.fromSeed(referenceAccent)
        : Palette.neutral();

    // ── copy, from Claude ──
    const channel = await this.channels.getChannel(projectId);
    const artifactList = await this.artifacts.listByProject(projectId);
    const pageCount = artifactList.find((a) => a.pageCount > 0)?.pageCount ?? null;

    // Loaded HERE rather than at render time because the layout call needs to
    // know whether a brand mark exists before it designs the header. Resolved,
    // not merely configured: a channel whose thumbnail URL is dead produces the
    // same empty header as one with no avatar at all, so the fetch is the only
    // honest signal.
    const logoDataUri = await this.loadLogo(channel?.thumbnailUrl ?? null);

    // ── the stored layout for this template ──
    // Captured once per reference and reused by every book that follows it.
    // That is what makes each page structurally identical to the template
    // instead of a fresh interpretation, and what removes a 30k-token Opus
    // call from every generation.
    const layout = referenceUrl
      ? await this.ensureLayout({
          projectId: input.projectId,
          referenceUrl,
          mode: project.options.landingMode,
          reference,
          referenceShots,
          productCount: 1 + project.options.landingSiblings.length,
          hasAuthorPhoto: Boolean(project.options.landingAuthorPhotoPath),
          hasLogo: logoDataUri !== null,
          rebuild: input.rebuildLayout ?? false,
        })
      : null;

    // ── the other books on this page ──
    // Loaded BEFORE the copy is written, not after: a three-book page needs
    // prose about three books, and a copywriter given only the featured book's
    // chapters writes about that book three times — which is how a "what's
    // inside" section came back as chapter ranges 1-5, 6-10, 11-14 of one
    // title where the template shows one block per book.
    //
    // A sibling that can't be loaded fails the whole generation rather than
    // silently reducing the page to fewer books.
    const siblingProducts: LandingProduct[] = [];
    for (const sibling of project.options.landingSiblings) {
      const loaded = await this.loadSiblingProduct(sibling, project.ownerId);
      if (loaded.isFail()) {
        page.markFailed(loaded.error, this.clock.now());
        await this.pages.saveState(page);
        return Result.fail(loaded.error);
      }
      siblingProducts.push(loaded.value);
    }

    const written = layout
      ? await this.writeSlotCopy({
          projectId: input.projectId,
          layout,
          bookTitle: title,
          subtitle: strategy?.subtitle ?? '',
          channelTitle: channel?.title ?? 'this creator',
          author: strategy?.author,
          strategy: strategy?.toText() ?? '',
          chapterTitles,
          pageCount,
          tone: project.options.tone,
          otherBooks: siblingProducts.map((p) => ({ title: p.title, chapterTitles: p.contents })),
        })
      : await this.writeFixedCopy({
          projectId: input.projectId,
          bookTitle: title,
          subtitle: strategy?.subtitle ?? '',
          channelTitle: channel?.title ?? 'this creator',
          author: strategy?.author,
          strategy: strategy?.toText() ?? '',
          chapterTitles,
          pageCount,
          tone: project.options.tone,
        });

    if (written.isFail()) {
      // On the fallback path this is usually the SECOND failure of the run: the
      // reference layout was already rejected, and THAT is the reason worth
      // reading. The layout reasons only ride out on the success return, so a
      // run that dies here reported a bare copy error and gave no hint that the
      // page had stopped following the template at all.
      const reason =
        !layout && this.lastLayoutFailure
          ? `${written.error} (the reference layout was rejected first: ${this.lastLayoutFailure.join('; ')})`
          : written.error;
      page.markFailed(reason, this.clock.now());
      await this.pages.saveState(page);
      return Result.fail(reason);
    }
    const { slotValues } = written.value;
    // The reference's own typography wins over the copy model's genre guess.
    // Left to itself the model picks "sans" for anything automotive or
    // technical — which is how a page copied from a serif-set template came
    // back in a sans face. What the reference actually does is observable, so
    // observe it rather than infer it.
    const copy: LandingCopy = reference
      ? {
          ...written.value.copy,
          fontFamily: reference.style.serifHeadings ? 'serif' : 'sans',
          // Independently observed: the reference's pairing is usually a serif
          // display face over sans body copy, and following the headings for
          // both set the small text in the wrong face.
          bodyFontFamily: reference.style.serifBody ? 'serif' : 'sans',
          // Resolved from the reference's named typefaces, so a display serif
          // is not flattened into the same Georgia as a book serif.
          displayFontStack: preferredStackFor(reference.style.headingFont, reference.style.serifHeadings),
          bodyFontStack: preferredStackFor(reference.style.bodyFont, reference.style.serifBody),
        }
      : written.value.copy;

    // ── render ──
    const product: LandingProduct = {
      title,
      subtitle: strategy?.subtitle ?? '',
      coverDataUri: cover.dataUri,
      pageCount,
      categoryLabel: copy.categoryLabel || null,
      features: copy.productFeatures,
      // A long chapter list buries the CTA; the first eight make the point.
      // Only used when the model gave no card features.
      contents: chapterTitles.slice(0, 8),
      // The table of contents, from the book's own outline rather than from the
      // model re-imagining contents it was only told the titles of.
      //
      // `items` carries the FULL key-point list because both renderers use it
      // only for its length — "5 methods" under each chapter. Neither prints
      // the points themselves: they are the book's substance, and a fourteen-
      // chapter book put about seventy of them on a free public page. Slicing
      // to 6 here also under-reported that count on any longer chapter.
      sections: book.outline.map((e) => ({
        title: e.title,
        items: e.keyPoints,
      })),
      priceCents: project.options.landingPriceCents ?? null,
      compareAtCents: project.options.landingCompareAtCents ?? null,
      checkoutUrl: project.options.landingCheckoutUrl ?? null,
      kind: 'book',
      // The book the user came from leads the page and takes the emphasised card.
      featured: true,
    };

    const products: LandingProduct[] = [product, ...siblingProducts];

    const bundle = this.buildBundle(project.options, products);
    if (bundle) products.push(bundle);

    // The seller's own photograph, if they uploaded one. Best-effort like every
    // other image: a page is still a page without a portrait.
    const authorPhoto = await this.loadAuthorPhoto(project.options.landingAuthorPhotoPath);

    const pageModel = {
      copy,
      palette,
      currency: project.options.landingCurrency,
      guaranteeDays: project.options.landingGuaranteeDays,
      author: strategy?.author ?? null,
      channelTitle: channel?.title ?? null,
      subscriberCount: channel?.subscriberCount ?? null,
      // Only ever real quotes, supplied by the user. None exist yet, so the
      // section is omitted rather than invented.
      testimonials: [],
      products,
      // A three-book page is the creator's storefront, not one book's page, so
      // it is named after the channel rather than after whichever book the user
      // happened to generate from.
      siteName: (project.options.isTripleLanding ? (channel?.title ?? title) : title),
      logoDataUri,
      // Every stat is a fact the system already holds — never a figure the
      // model wrote. A fabricated "4,200 readers" is a false claim about real
      // people, so a stat with no source simply doesn't render.
      stats: buildStats({
        pageCount,
        subscriberCount: channel?.subscriberCount ?? null,
        guaranteeDays: project.options.landingGuaranteeDays,
      }),
      // Still no UI for a separate hero image; the portrait doubles as one when
      // the layout wants a photographic hero.
      heroImageDataUri: null,
      authorPhotoDataUri: authorPhoto,
      authorCredential: buildCredential(strategy?.author, channel?.title ?? null),
      // The commercial furniture the reference page carries. Every one of these
      // is a factual claim — a real deadline, real reviewers, products that
      // exist, money a reader will actually save — so none is model-generated
      // and each stays absent until the seller supplies it.
      promoEndsAt: null,
      rating: null,
      valueStack: [],
      costComparison: null,
      // Empty for the same reason as the four fields above it, which it used to
      // contradict: nothing in the system knows what the seller's checkout
      // accepts. Naming four card brands under a buy button is a claim about
      // someone else's payment processor, and a buyer who picks the page's word
      // over their own store's finds out at the worst moment. Renders nothing
      // while empty; both renderers already omit the row.
      paymentMethods: [],
      edition: `${romanYear(this.clock.now().getFullYear())} · No. I`,
    };

    // ── render ──
    // With a stored layout the book's copy is poured into the template's own
    // markup; without one the built-in template renders the same model. Either
    // way the page gets built.
    const html = layout
      ? this.assembler.assemble({
          page: { css: layout.css, bodyHtml: fillCopySlots(layout.bodyHtml, slotValues) },
          model: pageModel,
        })
      : this.renderer.render(pageModel);

    page.setDraft({ copy, palette, html, inputHash }, this.clock.now());
    await this.pages.save(page);
    return Result.ok({
      regenerated: true,
      layout: layout ? ('generated' as const) : ('builtin' as const),
      referenceUrl,
      screenshots: referenceShots.length,
      ...(referenceNote ? { referenceNote } : {}),
      ...(this.lastLayoutFailure ? { layoutFailure: this.lastLayoutFailure } : {}),
      ...(this.lastVisualNotes ? { visualNotes: this.lastVisualNotes } : {}),
    });
  }


  /**
   * The layout for this template — from storage when it has been captured
   * before, otherwise derived once and stored for every book that follows.
   *
   * Returns null when no usable layout can be produced, which sends the page
   * down the built-in template instead. That is a fallback, not an error: a
   * plainer page beats no page.
   */
  private async ensureLayout(input: {
    projectId: string;
    referenceUrl: string;
    mode: LandingMode;
    reference: ReferencePage | null;
    referenceShots: ReferenceShot[];
    productCount: number;
    hasAuthorPhoto: boolean;
    hasLogo: boolean;
    rebuild: boolean;
  }): Promise<StoredLandingLayout | null> {
    // The inputs the LAYOUT depends on. Not the book — two books on the same
    // template share a layout, which is the entire point of the cache — but the
    // things the contract branches on when the layout is validated.
    const inputHash = this.hasher.hash({
      url: input.referenceUrl,
      mode: input.mode,
      products: input.productCount,
      photo: input.hasAuthorPhoto,
      logo: input.hasLogo,
    });

    // Reuse only a layout captured under the SAME inputs.
    //
    // Keying on the URL alone silently reused a one-book layout for a three-book
    // page, and the rules that would have caught it are conditional on exactly
    // these inputs — {{COVER}} is capped at 2 and {{COVER_STACK}} is required
    // only when productCount > 1, and {{AUTHOR_PHOTO}} is only placeable when a
    // photo exists. Those checks run when a layout is DERIVED, so a layout
    // captured under different inputs was never checked against them: the page
    // came back showing the featured book's cover three times, and the author
    // portrait in the top bar. This mismatch is also why edits to the prompt or
    // the contract appeared to do nothing — a cached layout returns before
    // either one is reached.
    //
    // A null hash is a layout stored before this check existed; treat it as
    // stale, since it is exactly the population that may carry those defects.
    if (!input.rebuild) {
      const stored = await this.layouts.find(input.referenceUrl, input.mode);
      // The whole point: every book after the first pays nothing for layout.
      if (stored && stored.inputHash === inputHash) return stored;
    }
    // A mismatched layout is not reused even as a fallback. It was validated
    // against a different product count, so it is the specific thing that
    // renders one cover three times; the built-in template is plainer but
    // correct at any count, which is the better of the two failures.
    if (!input.reference) return null; // nothing to copy from

    const derived = await this.deriveLayout(input);
    if (!derived) return null;

    // The reference's real typefaces, inlined — once per template, into the
    // stylesheet that every book on it will reuse. Licence-gated inside the
    // fetcher: only origins that serve openly-licensed fonts are embedded.
    const fontCss = input.reference ? await this.embedFonts(input.reference) : '';

    const stored: StoredLandingLayout = {
      referenceUrl: input.referenceUrl,
      mode: input.mode,
      css: fontCss + derived.css,
      bodyHtml: derived.bodyHtml,
      slots: derived.slots ?? [],
      inputHash,
    };
    // A store failure costs the cache, not the page — this generation already
    // has its layout in hand.
    await this.layouts.save(stored);
    return stored;
  }

  /**
   * Asks the model for a reusable layout copied from the reference. One repair
   * round, then give up and let the built-in template take over.
   */
  private async deriveLayout(input: {
    projectId: string;
    reference: ReferencePage | null;
    referenceShots: ReferenceShot[];
    productCount: number;
    hasAuthorPhoto: boolean;
    hasLogo: boolean;
  }): Promise<GeneratedPage | null> {
    this.lastLayoutFailure = undefined;
    this.lastVisualNotes = undefined;
    let repairErrors: string[] | undefined;
    /**
     * The best candidate seen so far: one that passed every mechanical check
     * but drew a visual complaint. See the note at the end of the loop.
     */
    let contractValid: GeneratedPage | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const prompt = LandingLayoutPrompt.build({
        reference: input.reference,
        productCount: input.productCount,
        hasAuthorPhoto: input.hasAuthorPhoto,
        hasLogo: input.hasLogo,
        referenceShots: input.referenceShots,
        ...(repairErrors ? { repairErrors } : {}),
      });

      const completion = await this.ai.generate({
        // Opus, and worth it: this runs once per template, not once per book.
        model: 'claude-opus-4-8',
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        maxTokens: 30_000,
        cacheControl: { systemPrefix: true },
        metadata: { projectId: input.projectId, stage: 'landing-layout' },
      });
      if (completion.isFail()) {
        this.lastLayoutFailure = [`Layout AI call failed: ${completion.error.type}`];
        return null;
      }

      if (completion.value.stopReason === 'max_tokens') {
        repairErrors = [
          'Your response was cut off at the output limit. Return the COMPLETE JSON: keep the stylesheet ' +
            'under 10,000 characters, remove repeated rule blocks, and keep the markup lean.',
        ];
        continue;
      }

      const parsed = parseJsonCompletion(completion.value.text, LayoutSchema);
      if (parsed.isFail()) {
        repairErrors = [`Your response was not valid JSON with keys "css", "bodyHtml" and "slots": ${parsed.error}`];
        continue;
      }

      const generated = parsed.value as GeneratedPage;
      const check = validateGeneratedPage(generated, {
        productCount: input.productCount,
        // The critical one: a layout with a book's words baked in would print
        // that book's headline on every other book that reuses the template.
        expectSlots: true,
      });
      if (check.isFail()) {
        repairErrors = check.error;
        continue;
      }

      // Mechanically valid is not the same as usable. Render it and look —
      // with the same images the layout was told it would have.
      contractValid = generated;
      const visual = await this.reviewRendered(generated, input.projectId, {
        authorPhoto: input.hasAuthorPhoto,
        logo: input.hasLogo,
      });
      if (visual.length === 0) return generated;
      repairErrors = visual;
    }
    // A layout that satisfied every mechanical check but kept drawing visual
    // complaints still ships.
    //
    // The alternative is the built-in template, which has no structural
    // relationship to the reference at all — so rejecting here trades a page
    // with a possible cosmetic flaw for one that is definitely the wrong page.
    // The reviewer is also not infallible: it judges still images, and it
    // reported the sticky bar overlapping mid-page content on every layout that
    // had one, which is what a sticky bar does rather than a defect.
    //
    // The complaints ride out as notes so they are visible in the log and the
    // response instead of being silently accepted.
    if (contractValid) {
      this.lastVisualNotes = repairErrors;
      return contractValid;
    }

    // The reasons ride back out so the worker can log them. Without this a
    // fallback is indistinguishable from success until someone compares the
    // page against the template by eye — which is exactly how a page that
    // silently ignored the reference reached the client.
    this.lastLayoutFailure = repairErrors;
    return null;
  }

  /**
   * Renders a candidate layout with filler copy and looks at it.
   *
   * Returns the visual defects found, or an empty list when the page is fine —
   * including when the check itself could not run. This is quality assurance,
   * not a gate: a browser that fails to launch must not stop a seller getting
   * a page, so an inconclusive review passes.
   */
  private async reviewRendered(
    layout: GeneratedPage,
    projectId: string,
    has: { authorPhoto: boolean; logo: boolean },
  ): Promise<string[]> {
    const html = this.assembler.assemble({
      page: { css: layout.css, bodyHtml: fillCopySlots(layout.bodyHtml, fillerFor(layout.slots ?? [])) },
      model: previewModel(has),
    });

    const shots = await this.screenshots.captureHtml(html);
    if (shots.isFail() || shots.value.length === 0) return [];

    const prompt = LayoutReviewPrompt.build({ shots: shots.value });
    const completion = await this.ai.generate({
      // Sonnet: this is "does this picture look broken", not design judgement,
      // and it runs on every layout derivation.
      model: 'claude-sonnet-4-6',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      maxTokens: 1500,
      cacheControl: { systemPrefix: true },
      metadata: { projectId, stage: 'landing-layout-review' },
    });
    if (completion.isFail()) return [];

    const parsed = parseJsonCompletion(
      completion.value.text,
      z.object({ ok: z.boolean(), problems: z.array(z.string()).default([]) }),
    );
    if (parsed.isFail()) return [];
    if (parsed.value.ok) return [];

    // Prefixed so the repair round can tell a rendering fault from a contract
    // breach — the fixes are different in kind.
    return parsed.value.problems.slice(0, 6).map((p) => `Visual defect in the rendered page: ${p}`);
  }

  /**
   * The reference's own fonts as inline `@font-face` rules, or nothing.
   *
   * Strictly best-effort and strictly licence-gated: a page falling back to the
   * closest system stack is a working page, and a font we may not redistribute
   * is one we do not download at all.
   */
  private async embedFonts(reference: ReferencePage): Promise<string> {
    const embedded = await this.fonts.embedFrom(reference.styleCss, reference.url);
    if (embedded.isFail() || embedded.value.length === 0) return '';
    return embedded.value.map((f) => f.fontFaceCss).join('\n') + '\n';
  }

  /** Fills a stored layout's slots for this book. */
  private async writeSlotCopy(input: {
    projectId: string;
    layout: StoredLandingLayout;
    bookTitle: string;
    subtitle: string;
    channelTitle: string;
    author: string | undefined;
    strategy: string;
    chapterTitles: string[];
    pageCount: number | null;
    tone: string;
    /** The other books on the page, with what each one actually covers. */
    otherBooks: Array<{ title: string; chapterTitles: string[] }>;
  }): Promise<Result<{ copy: LandingCopy; slotValues: Record<string, string> }>> {
    const prompt = LandingSlotCopyPrompt.build({ ...input, slots: input.layout.slots });

    const completion = await this.ai.generate({
      // Sonnet, not Opus: this is prose written from supplied source material
      // into slots whose purpose and length are already specified — the task
      // Sonnet is strongest at, at a fifth of the cost, and it now runs on
      // every generation where the layout call does not.
      model: 'claude-sonnet-4-6',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      maxTokens: 16_000,
      cacheControl: { systemPrefix: true },
      metadata: { projectId: input.projectId, stage: 'landing-page' },
    });
    if (completion.isFail()) return Result.fail(`Copywriting failed: ${completion.error.type}`);
    if (completion.value.stopReason === 'max_tokens') {
      return Result.fail(
        'The copywriting response was cut off at the output limit — the layout declares more slots than ' +
          'the budget allows.',
      );
    }

    const parsed = parseJsonCompletion(completion.value.text, z.record(z.string()));
    if (parsed.isFail()) return Result.fail(parsed.error);
    const slotValues = parsed.value;

    // The assembler needs a handful of these directly — the document title, the
    // meta description and the buy button's label. The contract guarantees the
    // layout declared them; the fallbacks cover a model that returned short.
    return Result.ok({
      slotValues,
      copy: {
        headline: slotValues['hero.headline'] ?? input.bookTitle,
        subheadline: slotValues['hero.subheadline'] ?? input.subtitle,
        ctaLabel: slotValues['cta.label'] ?? 'Get the book',
        eyebrow: '',
        painPoints: [],
        whatsInsideHeading: '',
        bullets: [],
        whoIsItForHeading: '',
        whoIsItFor: [],
        authorHeading: '',
        authorBio: '',
        faqs: [],
        categoryLabel: '',
        productFeatures: [],
        comparisonWithout: [],
        comparisonWith: [],
        closingHeading: '',
        closingBody: '',
        fontFamily: 'sans',
        templateSections: [],
      },
    });
  }

  /**
   * The no-reference path: the fixed copy schema that the built-in template
   * renders. Unchanged, and still the fallback whenever a layout cannot be
   * captured.
   */
  private async writeFixedCopy(input: {
    projectId: string;
    bookTitle: string;
    subtitle: string;
    channelTitle: string;
    author: string | undefined;
    strategy: string;
    chapterTitles: string[];
    pageCount: number | null;
    tone: string;
  }): Promise<Result<{ copy: LandingCopy; slotValues: Record<string, string> }>> {
    const prompt = LandingPagePrompt.build({ ...input, hasRealTestimonials: false });

    const completion = await this.ai.generate({
      model: 'claude-opus-4-8',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      maxTokens: 8_000,
      cacheControl: { systemPrefix: true },
      metadata: { projectId: input.projectId, stage: 'landing-page' },
    });
    if (completion.isFail()) return Result.fail(`Copywriting failed: ${completion.error.type}`);
    if (completion.value.stopReason === 'max_tokens') {
      return Result.fail('The copywriting response was cut off at the output limit.');
    }

    const parsed = parseJsonCompletion(completion.value.text, CopySchema);
    if (parsed.isFail()) return Result.fail(parsed.error);
    return Result.ok({ copy: parsed.value as LandingCopy, slotValues: {} });
  }

  /**
   * Loads one of the other books sold on this page, as its own product.
   *
   * Every failure here is fatal rather than skipped. The user asked for a page
   * selling three specific books; silently publishing one that sells two would
   * be wrong in a way nobody notices until a reader can't buy the book the page
   * promised.
   *
   * The ownership check is a security boundary, not a sanity check: the sibling
   * project id arrives from the client, so without it anyone could put someone
   * else's book — cover, title and all — on their own sales page.
   */
  private async loadSiblingProduct(
    sibling: { projectId: string; priceCents?: number | undefined; checkoutUrl?: string | undefined },
    ownerId: string,
  ): Promise<Result<LandingProduct>> {
    const siblingId = ProjectId.from(sibling.projectId);
    const siblingProject = await this.projects.findById(siblingId);
    if (!siblingProject) return Result.fail(`Selected book ${sibling.projectId} no longer exists`);
    if (siblingProject.ownerId !== ownerId) {
      return Result.fail(`Selected book ${sibling.projectId} belongs to a different account`);
    }

    const siblingBook = await this.books.findSummaryByProject(siblingId);
    if (!siblingBook || !siblingBook.hasChapters) {
      return Result.fail(`Selected book ${sibling.projectId} is not finished yet`);
    }

    const siblingStrategy = await this.knowledge.getBookStrategy(siblingId);
    const siblingTitle =
      normalizeBookTitle(
        siblingBook.title ?? siblingProject.options.bookTitle ?? siblingStrategy?.title ?? undefined,
      ) ?? 'Untitled';
    const siblingArtifacts = await this.artifacts.listByProject(siblingId);
    // Its own cover, embedded on its own card — the covers must not be shared
    // between products or every card would show the same book.
    const siblingCover = await this.loadCover(siblingBook.coverImagePath);

    return Result.ok({
      title: siblingTitle,
      subtitle: siblingStrategy?.subtitle ?? '',
      coverDataUri: siblingCover.dataUri,
      pageCount: siblingArtifacts.find((a) => a.pageCount > 0)?.pageCount ?? null,
      // The copy model wrote card features for the primary book only, so a
      // sibling's card is built from its own chapter titles instead.
      categoryLabel: null,
      features: [],
      contents: siblingBook.chapterTitles.slice(0, 8),
      sections: siblingBook.outline.map((e) => ({
        title: e.title,
        items: e.keyPoints.slice(0, 6),
      })),
      // Price and link come from THIS sibling's own entry, never from the
      // project it points at — the seller sets them per page.
      priceCents: sibling.priceCents ?? null,
      compareAtCents: null,
      checkoutUrl: sibling.checkoutUrl ?? null,
      kind: 'book',
    });
  }

  /**
   * The all-books bundle, when the seller has set one up. It is a real product
   * on their store with its own link, so it exists only when that link or price
   * was supplied — never synthesised to fill out the grid.
   */
  private buildBundle(
    options: { landingBundlePriceCents?: number | undefined; landingBundleCheckoutUrl?: string | undefined },
    books: LandingProduct[],
  ): LandingProduct | null {
    if (options.landingBundlePriceCents === undefined && !options.landingBundleCheckoutUrl) return null;
    if (books.length < 2) return null; // a "bundle" of one book is just the book
    return {
      title: `The complete set — all ${books.length} books`,
      subtitle: 'Every book above, in one purchase.',
      coverDataUri: null,
      pageCount: books.reduce((t, b) => t + (b.pageCount ?? 0), 0) || null,
      categoryLabel: null,
      features: books.map((b) => b.title),
      contents: [],
      sections: [],
      priceCents: options.landingBundlePriceCents ?? null,
      compareAtCents: null,
      checkoutUrl: options.landingBundleCheckoutUrl ?? null,
      kind: 'bundle',
      // Deliberately NOT `featured`. Both renderers resolve the page's hero
      // book as `products.find(p => p.featured)`, and a featured bundle — which
      // has no cover of its own — would blank the hero image.
      bundleCoverDataUris: books.map((b) => b.coverDataUri).filter((u): u is string => Boolean(u)),
    };
  }

  /**
   * Shrink an image to page scale and return it as a data URI, or null if it
   * cannot be made small enough to embed.
   *
   * Every image on the page goes through here. Nothing else is allowed to build
   * a data URI, because a single un-shrunk one is enough to push the row past
   * what the write can carry.
   */
  private async inlineImage(bytes: Uint8Array, maxWidth: number): Promise<string | null> {
    const shrunk = await this.imageProcessor.downscaleToDataUri({
      bytes,
      maxWidth,
      quality: INLINE_QUALITY,
    });
    // A failure here means the bytes are not a decodable image, so there is no
    // un-processed version worth falling back to — the browser would not render
    // it either. Drop it: every caller already treats a missing image as normal.
    return shrunk.isOk() ? shrunk.value : null;
  }

  /**
   * The seller's uploaded author portrait. Optional by design and never
   * substituted with the channel avatar: an avatar is usually a logo or a small
   * crop, and enlarging it into the hero portrait the reference pages use looks
   * worse than showing the cover there.
   */
  private async loadAuthorPhoto(path: string | undefined): Promise<string | null> {
    if (!path) return null;
    const bytes = await this.storage.getBytes(EXPORTS_BUCKET, path);
    if (bytes.isFail()) return null;
    return this.inlineImage(bytes.value.bytes, INLINE_WIDTHS.authorPhoto);
  }

  /**
   * The channel's avatar, used as the page's brand mark. Strictly best-effort,
   * like the cover: a dead avatar URL must never cost the seller their page.
   * Note this is NOT a stand-in for the author portrait — see loadAuthorPhoto.
   */
  private async loadLogo(thumbnailUrl: string | null): Promise<string | null> {
    if (!thumbnailUrl) return null;
    const fetched = await this.images.fetchBytes(thumbnailUrl);
    if (fetched.isFail()) return null;
    return this.inlineImage(fetched.value.bytes, INLINE_WIDTHS.logo);
  }

  /**
   * The cover feeds both the palette and the page's hero image. It is strictly
   * best-effort: a book whose cover generation failed still gets a landing page,
   * on a neutral palette with a typographic cover tile.
   */
  private async loadCover(
    path: string | null,
  ): Promise<{ dataUri: string | null; seed: { r: number; g: number; b: number } | null }> {
    if (!path) return { dataUri: null, seed: null };
    // One read, two uses: the colour sample wants the original pixels, and the
    // embedded copy is re-encoded from the same bytes. Sampling before the
    // downscale also keeps the palette off a re-compressed image.
    const bytes = await this.storage.getBytes(EXPORTS_BUCKET, path);
    if (bytes.isFail()) return { dataUri: null, seed: null };
    const [dataUri, sampled] = await Promise.all([
      this.inlineImage(bytes.value.bytes, INLINE_WIDTHS.cover),
      this.colors.dominantColor(bytes.value.bytes),
    ]);
    return { dataUri, seed: sampled.isOk() ? sampled.value : null };
  }
}
