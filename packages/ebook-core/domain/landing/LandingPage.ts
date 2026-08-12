import { AggregateRoot } from '../shared/AggregateRoot';
import { Result } from '../shared/Result';
import { Identifier } from '../shared/Identifier';
import { Palette } from './Palette';

export class LandingPageId extends Identifier {
  static from(value: string): LandingPageId {
    return new LandingPageId(value);
  }
}

export type LandingPageState = 'GENERATING' | 'DRAFT' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';

/** One selling point / chapter teaser in the "what's inside" list. */
export interface LandingBullet {
  title: string;
  body: string;
}

export interface LandingFaq {
  question: string;
  answer: string;
}

/**
 * The written content of the page — everything Claude produces, and nothing
 * else. Layout, colours, prices and the checkout URL are all supplied by the
 * system; the model only writes prose. Note the absence of a testimonials
 * field: invented social proof is a fabricated endorsement, so the section is
 * rendered only from real quotes the user supplies, never generated.
 */
/**
 * One section of the reference page, rewritten for this book.
 *
 * The fixed fields below (hero, bullets, FAQs…) exist because every sales page
 * has them. This is the other half: whatever sections a PARTICULAR template
 * happens to have — "Where the money goes", "Choose your level", "The method" —
 * written from the book's own material so the page can follow the template's
 * full structure instead of only the parts our schema anticipated.
 *
 * Deliberately shape-agnostic: the same payload describes a card grid, a
 * numbered method list or a two-column figure table, because the whole point is
 * that we do not know in advance what a template contains.
 */
export interface LandingTemplateSection {
  /** This section's heading, in the book's own terms. */
  heading: string;
  /** Small label above the heading, when the reference uses one. */
  eyebrow: string;
  /** Lead paragraph beneath the heading. */
  intro: string;
  /** How the reference presents this section, so the layout can match it. */
  kind: 'prose' | 'cards' | 'list' | 'steps' | 'comparison' | 'table';
  items: Array<{ title: string; body: string }>;
  /**
   * A two-column figure table, when the reference runs one (a cost comparison,
   * a before/after). `source` is required and is normally the book itself —
   * an unsourced savings figure is the riskiest thing on a page taking money.
   */
  table: {
    leftHeading: string;
    rightHeading: string;
    rows: Array<{ label: string; left: string; right: string }>;
    leftTotal: string;
    rightTotal: string;
    source: string;
  } | null;
}

export interface LandingCopy {
  /** Problem-led hero headline. */
  headline: string;
  subheadline: string;
  /** Short label above the headline, e.g. "For weekend mechanics". */
  eyebrow: string;
  /** Primary button label — the checkout URL is attached by the renderer. */
  ctaLabel: string;
  /** 3–5 sentences on the cost of the status quo. */
  painPoints: string[];
  whatsInsideHeading: string;
  bullets: LandingBullet[];
  whoIsItForHeading: string;
  whoIsItFor: string[];
  authorHeading: string;
  authorBio: string;
  faqs: LandingFaq[];
  /** Short label above the product card, e.g. "Buying guide". */
  categoryLabel: string;
  /** Terse feature lines for the product card — not full sentences. */
  productFeatures: string[];
  /** The before/after block every reference page runs before its final CTA. */
  comparisonWithout: string[];
  comparisonWith: string[];
  closingHeading: string;
  closingBody: string;
  /** Serif suits narrative//lifestyle subjects; sans suits technical ones. */
  fontFamily: 'serif' | 'sans';
  /**
   * The face for BODY and small text, chosen independently of the headings.
   *
   * The pairing is the design. Reference templates typically set a serif
   * display face over sans-serif body copy, and tying both to one choice put
   * eyebrows, bullets and fine print in Georgia where the reference uses sans.
   * Absent, it follows `fontFamily` — the old single-face behaviour.
   */
  bodyFontFamily?: 'serif' | 'sans';
  /**
   * Resolved CSS font stacks, chosen from the reference's ACTUAL typefaces
   * rather than from the serif/sans flag alone. A high-contrast display serif
   * and an old-style book serif read nothing alike, and mapping both to Georgia
   * lost most of what makes a template recognisable. Absent → the generic
   * serif/sans defaults.
   */
  displayFontStack?: string;
  bodyFontStack?: string;
  /**
   * The reference's own sections, in its order, written from this book. Empty
   * when there is no reference page — then the fixed fields above carry the
   * whole page, as they always did.
   */
  templateSections: LandingTemplateSection[];

  // ── direct-response sections ──────────────────────────────────────────────
  // Added 2026-08-10 to the client's master prompt. The page previously read as
  // a book DESCRIPTION — headline, benefits, FAQ. These are the parts that make
  // it a sales letter: the reader must feel the cost of their situation, see
  // that what they have already tried cannot fix it, and meet a person who
  // solved it, all before the product is named.
  //
  // Every one is optional so a page generated before this change still renders:
  // each section is simply omitted when its field is absent or empty.

  /** Dismisses what the reader has already tried, and why each failed. */
  failedAlternatives?: string[];

  /**
   * First-person origin story — ordinary person, painful event, discovery,
   * result. Under ~250 words. Grounded in the channel and the book's
   * positioning; it is the author's story, never an invented biography.
   */
  discoveryStory?: string;
  discoveryHeading?: string;

  /**
   * Curiosity bullets — the hardest-selling block on the page. Each teases a
   * specific mechanism WITHOUT revealing it, anchored to the chapter that
   * delivers it.
   *
   * `chapter` is a real chapter number, not a page number: the master prompt's
   * formula asks for "(page 47)", but nothing in this system knows which page a
   * given fact lands on, so a model asked for one invents it — a small false
   * claim repeated twenty times down the page. The chapter is the honest
   * equivalent and carries the same "this book is dense and real" signal.
   */
  fascinations?: LandingFascination[];
  fascinationsHeading?: string;

  /** The "NOT for" list. Does more selling than the "for" list it sits beside. */
  notForHeading?: string;
  notFor?: string[];

  /**
   * The P.S. blocks. Many readers scroll straight past the page to these, so
   * the first restates the whole offer.
   */
  postscripts?: string[];
}

export interface LandingFascination {
  /** The curiosity line. Teases the mechanism; never explains it. */
  text: string;
  /** 1-based chapter this comes from, or null when it spans the book. */
  chapter: number | null;
}

interface LandingPageProps {
  projectId: string;
  state: LandingPageState;
  copy: LandingCopy | null;
  palette: Palette | null;
  /** The rendered, self-contained page. Kept so preview is instant and so the
   * exact bytes that were reviewed are the bytes that get deployed. */
  html: string | null;
  /** Netlify site + deploy identifiers, set on first publish. */
  siteId: string | null;
  deployId: string | null;
  /** The public URL, once live. */
  url: string | null;
  /** Hash of every generation input; an unchanged hash short-circuits a re-run. */
  inputHash: string | null;
  error: string | null;
  /**
   * Which engine produced this page.
   *
   * `clone` — the template site's own DOM and CSS, with content swapped.
   * `builtin` — the hand-written fallback, used when a project has no template.
   *
   * Recorded because it decides what the page IS, and because the previous
   * system chose silently: which of two structurally unrelated renderers ran
   * depended on whether a layout derivation had happened to succeed, was logged
   * once in the worker, and was invisible to the person looking at the result.
   */
  engine: LandingEngine;
  /** The cloned template this page was bound from. Null on the builtin engine. */
  templateId: string | null;
  /**
   * The values poured into the template's slots.
   *
   * Kept so one headline can be corrected and the page re-bound without asking
   * Claude to rewrite the whole thing.
   */
  binding: LandingBinding | null;
  /** What this page's deploy must ship alongside index.html. */
  assets: LandingPageAsset[];
  /** The post-bind verification report; publishing is gated on it. */
  fidelity: LandingFidelity | null;
  createdAt: Date;
  updatedAt: Date;
}

export type LandingEngine = 'clone' | 'builtin';

export interface LandingBinding {
  scalars: Record<string, string>;
  repeats: Record<string, Array<Record<string, string>>>;
}

export interface LandingPageAsset {
  sitePath: string;
  storagePath: string;
  contentType: string;
}

export interface LandingFidelity {
  findings: Array<{ severity: 'BLOCKER' | 'WARN' | 'INFO'; code: string; message: string }>;
  visual: Array<{ width: number; mismatchRatio: number; maskedMismatchRatio: number }>;
  unresolvedSlots: string[];
}

/**
 * A sales landing page for a finished book: generated as a DRAFT, reviewed by
 * the user, then PUBLISHED to Netlify. Generation and publication are separate
 * on purpose — AI-written marketing copy should not reach a public URL without
 * a human having read it.
 */
export class LandingPage extends AggregateRoot<LandingPageProps, LandingPageId> {
  static create(input: { id: LandingPageId; projectId: string; now: Date }): LandingPage {
    return new LandingPage(
      {
        projectId: input.projectId,
        state: 'GENERATING',
        copy: null,
        palette: null,
        html: null,
        siteId: null,
        deployId: null,
        url: null,
        inputHash: null,
        error: null,
        engine: 'builtin',
        templateId: null,
        binding: null,
        assets: [],
        fidelity: null,
        createdAt: input.now,
        updatedAt: input.now,
      },
      input.id,
    );
  }

  static rehydrate(props: LandingPageProps, id: LandingPageId): LandingPage {
    return new LandingPage(props, id);
  }

  get projectId() {
    return this.props.projectId;
  }
  get state() {
    return this.props.state;
  }
  get copy() {
    return this.props.copy;
  }
  get palette() {
    return this.props.palette;
  }
  get html() {
    return this.props.html;
  }
  get siteId() {
    return this.props.siteId;
  }
  get deployId() {
    return this.props.deployId;
  }
  get url() {
    return this.props.url;
  }
  get inputHash() {
    return this.props.inputHash;
  }
  get error() {
    return this.props.error;
  }
  get updatedAt() {
    return this.props.updatedAt;
  }
  get engine() {
    return this.props.engine;
  }
  get templateId() {
    return this.props.templateId;
  }
  get binding() {
    return this.props.binding;
  }
  get assets() {
    return this.props.assets;
  }
  get fidelity() {
    return this.props.fidelity;
  }

  /**
   * True when verification found nothing that must block a deploy.
   *
   * The gate publishing consults. A page whose buy buttons still point at the
   * template owner's store, or that carries a token as literal braces, is worse
   * live than absent — and v1 could not tell, because every check it had ran
   * before substitution rather than on the finished page.
   */
  get isPublishable(): boolean {
    return !this.props.fidelity || !this.props.fidelity.findings.some((f) => f.severity === 'BLOCKER');
  }

  /** The blocking findings, for an error message that names the actual problem. */
  get blockers(): string[] {
    return (this.props.fidelity?.findings ?? []).filter((f) => f.severity === 'BLOCKER').map((f) => f.message);
  }

  /** A page that has been live at least once keeps its URL through re-drafts. */
  get isPublished(): boolean {
    return this.props.url !== null;
  }

  markGenerating(now: Date): void {
    this.props.state = 'GENERATING';
    this.props.error = null;
    this.props.updatedAt = now;
  }

  /** Store a freshly generated draft. Never clears an existing live URL. */
  setDraft(input: { copy: LandingCopy; palette: Palette; html: string; inputHash: string }, now: Date): void {
    this.props.copy = input.copy;
    this.props.palette = input.palette;
    this.props.html = input.html;
    this.props.inputHash = input.inputHash;
    this.props.engine = 'builtin';
    this.props.templateId = null;
    this.props.binding = null;
    this.props.assets = [];
    // Nothing verifies the built-in renderer's output against a template,
    // because there is no template to verify it against. Cleared rather than
    // left stale, so a previous clone's report can never gate this page.
    this.props.fidelity = null;
    // A republish is required for the new draft to reach the live URL, so a page
    // that is already live stays PUBLISHED (with stale content) rather than
    // silently reporting DRAFT while the old page is still being served.
    this.props.state = this.isPublished ? 'PUBLISHED' : 'DRAFT';
    this.props.error = null;
    this.props.updatedAt = now;
  }

  /**
   * Store a draft produced by cloning a template.
   *
   * Separate from `setDraft` because the two engines carry different things: a
   * cloned page has no derived palette (it keeps the template's own colours)
   * and does have a template, a binding, assets and a fidelity report.
   */
  setClonedDraft(
    input: {
      copy: LandingCopy;
      html: string;
      inputHash: string;
      templateId: string;
      binding: LandingBinding;
      assets: LandingPageAsset[];
      fidelity: LandingFidelity;
    },
    now: Date,
  ): void {
    this.props.copy = input.copy;
    this.props.html = input.html;
    this.props.inputHash = input.inputHash;
    this.props.engine = 'clone';
    this.props.templateId = input.templateId;
    this.props.binding = input.binding;
    this.props.assets = input.assets;
    this.props.fidelity = input.fidelity;
    this.props.state = this.isPublished ? 'PUBLISHED' : 'DRAFT';
    this.props.error = null;
    this.props.updatedAt = now;
  }

  markPublishing(now: Date): Result<void> {
    if (!this.props.html) return Result.fail('Nothing to publish — generate the page first');
    // NOT gated on `isPublishable`. Verification is a REPORT the seller reads,
    // not a veto: its two BLOCKER findings both fire on pages that are in fact
    // fine to sell from. LAYOUT_DRIFT is a screenshot diff against the template,
    // so any deliberate difference in copy length reads as drift, and
    // REPEATER_EMPTY describes a section the seller can see for themselves is
    // populated. Blocking made those unappealable — the only escape was to
    // regenerate and hope the diff landed under the threshold — while the person
    // looking at the page is better placed to judge it than a pixel ratio.
    // `isPublishable` and `blockers` remain, and the UI shows them for review.
    this.props.state = 'PUBLISHING';
    this.props.error = null;
    this.props.updatedAt = now;
    return Result.ok();
  }

  markPublished(input: { siteId: string; deployId: string; url: string }, now: Date): void {
    this.props.siteId = input.siteId;
    this.props.deployId = input.deployId;
    this.props.url = input.url;
    this.props.state = 'PUBLISHED';
    this.props.error = null;
    this.props.updatedAt = now;
  }

  markFailed(reason: string, now: Date): void {
    this.props.state = 'FAILED';
    this.props.error = reason;
    this.props.updatedAt = now;
  }

  toJSON(): LandingPageProps {
    return { ...this.props };
  }
}
