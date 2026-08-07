import type { Result } from '../../../domain/shared/Result';
import type {
  PlaceholderEntry,
  RepeaterEntry,
  SectionGeometry,
  ThemeTokens,
  TypographyTokens,
} from '../../../domain/landing/TemplateManifest';

/**
 * Renders a template site in a real browser and returns everything needed to
 * reproduce it — its DOM, its stylesheets, its assets, and measurements of what
 * it looks like.
 *
 * This replaces both `ReferencePageFetcher` (which used plain `fetch` and so saw
 * an empty app shell on any client-rendered site) and `ReferenceScreenshotter`.
 * The two produced descriptions of DIFFERENT documents — one the server HTML,
 * one the painted page — and the model was asked to reconcile them. Here one
 * browser session produces all of it, so the DOM, the CSS and the screenshots
 * are the same page by construction.
 *
 * SECURITY: the URL comes from a user and this drives a real browser inside the
 * worker's network — the most capable SSRF sink in the system. Implementations
 * MUST refuse non-public addresses before navigating, on every hop.
 */

/** One captured image. Base64 WITHOUT the `data:` prefix. */
export interface Shot {
  width: number;
  mediaType: string;
  dataBase64: string;
}

/** A downloadable the template references. */
export interface CapturedAsset {
  sourceUrl: string;
  kind: 'image' | 'font' | 'other';
  bytes: Uint8Array;
  contentType: string;
}

/**
 * One candidate node offered to the annotation model.
 *
 * Deliberately not markup. The model sees an outline — what kind of node it is,
 * where it sits, what it says — and returns labels for ids in this list. It
 * cannot express a change to the document because nothing it can say is markup.
 */
export interface InventoryNode {
  tplId: string;
  tag: string;
  /** Up to three ancestor tag.class hops, for orientation. */
  path: string;
  /** Visible text, capped. Absent for images. */
  text?: string | undefined;
  chars?: number | undefined;
  href?: string | undefined;
  src?: string | undefined;
  alt?: string | undefined;
  /** Rendered size at 1280px. Distinguishes a hero image from an icon. */
  width?: number | undefined;
  height?: number | undefined;
  /**
   * Position and size at 1280px, in page coordinates.
   *
   * Captured so the visual diff can MASK this node: content replaced on purpose
   * must not count as drift, or every page fails its own check. Only measured
   * at 1280 — masking the narrower widths would need an inventory pass per
   * width, and the desktop check is the one that catches real breakage.
   */
  rect?: { x: number; y: number; width: number; height: number } | undefined;
  /** The `data-tpl` of the nearest section/header/footer ancestor. */
  sectionId?: string | undefined;
  /** True when replacing this node's text would drop inline markup. */
  hasInlineMarkup?: boolean | undefined;
}

export interface CapturedTemplate {
  sourceUrl: string;
  /** After redirects — what was actually rendered. */
  finalUrl: string;
  title: string;
  /** The page exactly as the browser rendered it, before any cleaning. */
  originalHtml: string;
  /** The cleaned, id-stamped DOM. Scripts, forms and trackers already gone. */
  cleanHtml: string;
  /** Every stylesheet, in document order, already concatenated. */
  css: string;
  assets: CapturedAsset[];
  inventory: InventoryNode[];
  /** Detected mechanically; `key` is empty until the annotation call names each. */
  repeaters: RepeaterEntry[];
  /**
   * Nodes detected as buy buttons, by href pattern and by styling.
   *
   * Deterministic, and it OVERRIDES the annotation model rather than deferring
   * to it: a missed checkout link is a live anchor still pointing at the
   * template owner's store, which is the worst defect a cloned page can carry.
   */
  ctaIds: string[];
  theme: ThemeTokens;
  /** The typefaces the browser actually resolved, per role. */
  typography: TypographyTokens;
  sections: SectionGeometry[];
  /** Of the ORIGINAL page — the fidelity target. */
  baselineShots: Shot[];
  /** Of the CLEANED page — what is actually reproducible. */
  cleanedShots: Shot[];
  /** Images too large to be decorative that carry no placeholder yet. */
  contentImages: Array<{ tplId: string; sourceUrl: string; width: number; height: number }>;
  notes: string[];
}

export interface ParameteriseInput {
  cleanHtml: string;
  /** The annotation result, already filtered through the deterministic guards. */
  placeholders: PlaceholderEntry[];
  repeaters: RepeaterEntry[];
}

export interface TemplateCapturer {
  /** Stages 1–2: render, clean, stamp, inventory, measure, screenshot. */
  capture(url: string): Promise<Result<CapturedTemplate>>;

  /**
   * Stage 4: apply a placeholder map to the cleaned DOM.
   *
   * Runs in the browser against a real DOM rather than over the HTML string,
   * because addressing a node by id and replacing its content is a tree
   * operation. Every entry whose `tplId` does not resolve is dropped and
   * reported — which is why a hallucinated id cannot corrupt the template.
   */
  parameterise(input: ParameteriseInput): Promise<Result<{ html: string; appliedIds: string[]; droppedIds: string[] }>>;

  /**
   * Renders a self-contained page and captures it at each width. Used for the
   * post-bind visual diff and for the filler render during extraction.
   *
   * No navigation and no network: the document is assembled from bytes we
   * already hold, so there is no SSRF surface here.
   */
  shoot(input: { html: string; assets: Array<{ sitePath: string; bytes: Uint8Array; contentType: string }>; widths: number[] }): Promise<Result<Shot[]>>;
}
