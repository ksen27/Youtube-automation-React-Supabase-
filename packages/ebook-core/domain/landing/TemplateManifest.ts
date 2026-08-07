import type { PlaceholderKind } from './PlaceholderVocabulary';

/**
 * Everything known about one cloned template, other than its bytes.
 *
 * The HTML and CSS live in object storage; this is the description of what is
 * in them and how to fill them. It is the contract between extraction (which
 * produces it once) and generation (which reads it per book).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One node in the template that holds replaceable content. */
export interface PlaceholderEntry {
  /** The `data-tpl` id of the node this token replaces content in. */
  tplId: string;
  /** Token key — a core name, a repeater field, or `SECTION:<id>.<field>`. */
  placeholder: string;
  kind: PlaceholderKind;
  /**
   * Soft ceiling for the value, measured as the ORIGINAL text length × 1.15.
   *
   * Measured rather than chosen: the template's CSS was tuned to the words that
   * were there, so the original length is the only honest budget. The previous
   * pipeline had the model invent a `maxChars` per slot with nothing to anchor
   * it to, which is why copy overflowed boxes it was never sized for.
   */
  maxChars: number;
  /** What the node said originally. The copy brief, and the diff baseline. */
  originalText: string;
  /**
   * True when the node contained inline markup (a styled `<span>` inside a
   * heading) that replacing its text content will drop.
   *
   * Recorded rather than prevented: preserving an accent span around words that
   * are about to be replaced is not meaningful, but losing it is a visible
   * change and the report should say so rather than let it be discovered.
   */
  hadInlineMarkup: boolean;
  /**
   * Where the node sat at 1280px, so the visual check can mask it. Absent for
   * nodes added by a deterministic guard rather than measured.
   */
  rect?: Rect | undefined;
}

/** A container whose children repeat — benefit cards, FAQ rows, offer cards. */
export interface RepeaterEntry {
  /**
   * Core repeater name, e.g. `BENEFITS`. Empty until the annotation call names
   * it — detection is mechanical, naming is the one part that needs judgement.
   */
  key: string;
  containerTplId: string;
  /** The child kept as the item template; its siblings are regenerated from it. */
  itemTplId: string;
  /** How many items the template shipped with. The default bind count. */
  originalCount: number;
  /**
   * Whether the container can take a different number of items without
   * breaking. Read from the container's computed `grid-template-columns`: an
   * `auto-fit`/`auto-fill` grid reflows, a hand-tuned three-across flex row
   * does not. A measurement, not an assumption.
   */
  flexibleCount: boolean;
  /** Fields the item's markup actually carries tokens for. */
  fields: string[];
}

/** The template's own colour identity, read from the live page. */
export interface ThemeTokens {
  /**
   * The `:root` custom property whose resolved value is the CTA's background,
   * when the template uses one. Null on a template that writes literal colours.
   */
  accentToken: string | null;
  /** The CTA's computed background colour, as `#rrggbb`. */
  accentValue: string | null;
  /** The CTA's computed text colour — what the new accent must stay readable against. */
  onAccentValue: string | null;
  /** Whether the page's own background is dark. Never changed; only recorded. */
  isDark: boolean;
  /** Every resolved `:root` custom property, for the review UI and diagnostics. */
  rootTokens: Record<string, string>;
}

/** One role's typeface, as the browser resolved it on the live page. */
export interface TypefaceRole {
  /** The first named family, e.g. "Playfair Display". Never a generic keyword. */
  family: string;
  /** The full computed stack, kept so the original fallbacks survive. */
  stack: string;
  weight: string;
  /** Whether the resolved face is a serif. Measured, not inferred from the name. */
  serif: boolean;
}

/**
 * The template's measured typography.
 *
 * Captured because the clone pipeline otherwise has no idea what typeface a
 * template uses: `@font-face` rules are stripped before storage and re-added
 * only when the licence allows, but the `font-family` declarations naming them
 * survive. Without this, a face that could not be embedded left the page asking
 * for a font nobody has, and the browser fell back to Times New Roman — which is
 * why cloned pages matched their template everywhere except the type.
 */
export interface TypographyTokens {
  heading: TypefaceRole | null;
  body: TypefaceRole | null;
  /** Every distinct real family the page paints, for the fidelity report. */
  familiesUsed: string[];
}

/** Per-width geometry, captured for the visual diff's masking. */
export interface SectionGeometry {
  tplId: string;
  tag: string;
  width: number;
  rect: Rect;
  paddingBlock: [number, number];
  background: string;
}

export interface ResponsiveRules {
  /** Widths the template was captured at. */
  widths: number[];
  /** Breakpoints parsed from the bundle's `@media` queries, ascending. */
  breakpoints: number[];
  sections: SectionGeometry[];
}

export interface TemplateAsset {
  contentHash: string;
  /** Path inside the deployed site, e.g. `assets/a1b2c3d4.woff2`. */
  sitePath: string;
  /** Path in the `landing-assets` bucket. Empty when `rehosted` is false. */
  storagePath: string;
  contentType: string;
  byteSize: number;
  kind: 'image' | 'font' | 'other';
  sourceUrl: string | null;
  /**
   * False for a font whose licence does not permit redistribution: recorded so
   * the report can say the typeface degraded, but not stored and not deployed.
   */
  rehosted: boolean;
}

/** A finding from extraction or verification. */
export interface Finding {
  severity: 'BLOCKER' | 'WARN' | 'INFO';
  code: string;
  message: string;
}

export interface ExtractionReport {
  findings: Finding[];
  /**
   * How much the page changed when scripts and trackers were removed, as a
   * pixel-mismatch ratio against the pre-cleaning capture.
   *
   * This is the honest measure of what cloning costs. A template driven by a
   * JS reveal library scores badly here and should be rejected before anyone
   * builds a page on it, rather than after.
   */
  cleaningLoss: Array<{ width: number; mismatchRatio: number }>;
  /** Images that were dropped rather than republished, for the seller to replace. */
  droppedImages: Array<{ tplId: string; sourceUrl: string; rect: Rect }>;
  /**
   * `exact` only when EVERY declared face embedded. Partial success is
   * `degraded`, because a page that kept its body text but lost its display
   * face does not look like its template — and reporting that as exact told the
   * seller their typography was perfect when the headline had changed typeface.
   */
  fontFidelity: 'exact' | 'degraded' | 'none';
  /** Families the page asks for that no embedded face provides. */
  lostFamilies: string[];
  assetBytes: number;
  sectionCount: number;
  /**
   * Repeating regions MECHANICAL detection found, before the model named any.
   *
   * The difference between "detection found nothing" and "the model named
   * nothing it found" — two very different bugs that look identical from a
   * stored row, and the first extraction could not distinguish them.
   */
  detectedRepeaters: Array<{ containerTplId: string; itemCount: number; flexibleCount: boolean }>;
  /**
   * Price-like strings left in the template with no {{PRICE}} label.
   *
   * Recorded rather than judged. On a page about saving money on airfare,
   * "$1,400" is the copy's subject, not the product's price — treating every
   * currency string as a leaked price failed a template that cloned perfectly.
   * Which of them matters can only be decided once the seller's own price is
   * known, so the decision moves to bind time and these are what it checks.
   */
  residualPrices: string[];
  notes: string[];
}

export type LandingTemplateState = 'EXTRACTING' | 'READY' | 'FAILED';

/** A user's correction to the annotation, re-applied across re-extractions. */
export interface PlaceholderOverride {
  placeholder: string;
  action: 'relabel' | 'keep' | 'remove';
  /** For `relabel`: the token to use instead. */
  replacement?: string | undefined;
  /** For `keep`/`remove`: which node, addressed by its original text. */
  matchText?: string | undefined;
}

export interface StoredLandingTemplate {
  id: string;
  ownerId: string;
  sourceUrl: string;
  state: LandingTemplateState;
  name: string | null;

  originalHtmlPath: string | null;
  cleanHtmlPath: string | null;
  cssBundlePath: string | null;

  placeholders: PlaceholderEntry[];
  repeaters: RepeaterEntry[];
  theme: ThemeTokens;
  typography: TypographyTokens;
  responsive: ResponsiveRules;
  baselineShots: Array<{ width: number; storagePath: string }>;
  overrides: PlaceholderOverride[];

  report: ExtractionReport | null;
  failureReason: string | null;

  pipelineVersion: number;
  revision: number;
  capturedAt: Date | null;
}

/**
 * Bumped on any change to capture, cleaning, annotation or parameterisation.
 *
 * Part of the template's natural key, so a pipeline fix re-extracts on next use
 * instead of sitting behind a manual rebuild flag. The 0012 layout cache had no
 * such field, which is why every prompt and contract fix to that path appeared
 * to do nothing — a cached row returned before the changed code was reached.
 */
export const LANDING_PIPELINE_VERSION = 2;
