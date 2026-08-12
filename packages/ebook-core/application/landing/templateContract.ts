import { Result } from '../../domain/shared/Result';
import {
  REQUIRED_PLACEHOLDERS,
  REPEATER_PLACEHOLDERS,
  TOKEN_RE,
  kindFor,
  token,
} from '../../domain/landing/PlaceholderVocabulary';
import type { Finding, PlaceholderEntry, RepeaterEntry } from '../../domain/landing/TemplateManifest';

/**
 * What a cloned template and a bound page must satisfy.
 *
 * The v1 contract validated markup a MODEL had written, so most of it was about
 * stopping the model doing something dangerous — no scripts, no raw colours, no
 * external URLs, balanced tags. Very little of that applies now: the markup is
 * the template's own and the model never touches it.
 *
 * What replaces it is verification that the clone is faithful and that the
 * commercially dangerous parts are ours. Both of the checks that matter most —
 * "does every buy button point at the seller's checkout" and "did the template's
 * buy buttons all survive" — had no equivalent in v1 at all.
 */

/**
 * Currency-looking text in rendered markup.
 *
 * Exported so the recorded list and the human-readable warning come from ONE
 * definition. They did not: the warning named only the first three for
 * readability, and the record was parsed back out of that message — so the
 * publish-time gate silently checked three of eleven figures.
 */
export function findPriceLikeText(html: string): string[] {
  const matches = html.replace(/<[^>]+>/g, ' ').match(PRICE_LIKE) ?? [];
  return [...new Set(matches.map((v) => v.trim()))];
}

const PRICE_LIKE = /[$£€]\s?\d[\d.,]*|(?:^|\s)\d[\d.,]*\s?(?:USD|EUR|GBP)/g;

function blocker(code: string, message: string): Finding {
  return { severity: 'BLOCKER', code, message };
}
function warn(code: string, message: string): Finding {
  return { severity: 'WARN', code, message };
}

/** Minimum sections before a capture is more likely an app shell than a page. */
const MIN_SECTIONS = 3;

export interface TemplateValidationInput {
  html: string;
  placeholders: PlaceholderEntry[];
  repeaters: RepeaterEntry[];
  /** Host of the template's own site — no link may still point there. */
  sourceHost: string;
  /** How many buy anchors the original page had. */
  originalCtaCount: number;
  sectionCount: number;
}

/**
 * Validates a parameterised template, before it is stored.
 */
export function validateTemplate(input: TemplateValidationInput): Result<void, Finding[]> {
  const findings: Finding[] = [];
  const { html } = input;

  // ── the vocabulary ────────────────────────────────────────────────────────
  // A template that sells a SET has no single "the book" cover — its covers
  // live one per card in the product repeater, which is where they belong. The
  // requirement is that the page shows cover art, and OFFER_ITEMS.coverSrc does
  // that for every product rather than for one.
  //
  // This is the same mistake the v1 contract made with {{COVER}}: demanding one
  // specific placeholder when a multi-product page legitimately uses a
  // different one, so a correct answer was rejected and there was no passing
  // response available.
  // Any repeating region carrying a cover per item, not just the offer grid —
  // a template can show its books in a "what's inside" row as readily as in a
  // pricing row, and either one covers every product rather than only one.
  const coversInRepeater = /\{\{[A-Z_]+\.coverSrc\}\}/.test(html);
  for (const key of REQUIRED_PLACEHOLDERS) {
    if (html.includes(token(key))) continue;
    if (key === 'BOOK_COVER' && coversInRepeater) continue;
    findings.push(
      blocker(
        'MISSING_REQUIRED_PLACEHOLDER',
        key === 'BOOK_COVER'
          ? // Naming the consequence, because the fix is a decision rather than
            // a retry: every image on this page is still the template owner's,
            // so publishing it would show THEIR book covers on a page selling
            // someone else's book.
            'No image was labelled as a product cover. Label one node BOOK_COVER, or — if the template ' +
              'shows several products — label the covers inside a repeating region as <KEY>.coverSrc so each ' +
              "product gets its own. Without this the page would keep the template owner's cover images."
          : `No node was labelled ${token(key)}; the page cannot be filled.`,
      ),
    );
  }

  const used = new Set<string>();
  for (const match of html.matchAll(TOKEN_RE)) {
    const key = match[1] ?? '';
    used.add(key);
    if (!kindFor(key)) {
      findings.push(blocker('UNKNOWN_TOKEN', `${match[0]} is not a token this system knows how to fill.`));
    }
  }

  // ── the placeholder map must describe the markup ──────────────────────────
  for (const entry of input.placeholders) {
    if (!used.has(entry.placeholder)) {
      findings.push(
        warn(
          'PLACEHOLDER_NOT_PLACED',
          `${token(entry.placeholder)} is in the map but not in the markup — its node was probably dropped.`,
        ),
      );
    }
    if (entry.maxChars <= 0) {
      findings.push(blocker('BAD_MAX_CHARS', `${token(entry.placeholder)} has a non-positive character budget.`));
    }
  }

  // ── repeaters ─────────────────────────────────────────────────────────────
  for (const repeater of input.repeaters) {
    if (!REPEATER_PLACEHOLDERS[repeater.key]) {
      findings.push(blocker('UNKNOWN_REPEATER', `"${repeater.key}" is not a known repeating region.`));
      continue;
    }
    if (!html.includes(`data-repeat="${repeater.key}"`)) {
      findings.push(
        blocker('REPEATER_NOT_PLACED', `Repeater "${repeater.key}" is declared but has no <template> in the markup.`),
      );
    }
    if (repeater.originalCount < 1) {
      findings.push(warn('EMPTY_REPEATER', `Repeater "${repeater.key}" captured no items.`));
    }
  }
  for (const match of html.matchAll(/data-repeat="([^"]+)"/g)) {
    const key = match[1] ?? '';
    if (!input.repeaters.some((r) => r.key === key)) {
      findings.push(blocker('UNDECLARED_REPEATER', `<template data-repeat="${key}"> is not in the repeater map.`));
    }
  }

  // ── the checkout must survive cloning intact ──────────────────────────────
  // Asymmetric on purpose. A MISSING one is a live anchor still pointing at the
  // template owner's store — the worst thing a cloned page can ship. An EXTRA
  // one is a link the detector's heuristics missed and the model caught, and it
  // points at the seller's own checkout, which costs nothing.
  //
  // Requiring exact equality made both directions fatal, and the model finding
  // a seventh buy button on a six-button page failed the whole extraction.
  //
  // BOTH directions are warnings now. A shortfall does not mean an unlabelled
  // buy button survived, because the model does not get the last word on this:
  // resolveAnnotation force-assigns CHECKOUT_URL to EVERY detected cta id
  // ("the guard that outranks the model"). A token can therefore only go
  // missing when its markup went with it — the node was dropped as no longer
  // present (NODES_DROPPED), or it sat in a repeating region whose extra items
  // are collapsed to one <template> item by design, which is how a 3-card
  // pricing grid turns three detected buttons into one token.
  //
  // Blocking cost a real template its whole extraction over exactly that
  // ("7 buy buttons but only 5 were labelled"), and the danger it named is
  // covered directly below: a link still pointing at the template's own host is
  // a BLOCKER via residualSourceLinks, which reads the finished markup rather
  // than inferring from a count.
  const ctaCount = occurrences(html, token('CHECKOUT_URL'));
  if (input.originalCtaCount > 0 && ctaCount < input.originalCtaCount) {
    findings.push(
      warn(
        'CTA_COUNT_CHANGED',
        `The template had ${input.originalCtaCount} buy ${input.originalCtaCount === 1 ? 'button' : 'buttons'} but ` +
          `only ${ctaCount} ${ctaCount === 1 ? 'carries' : 'carry'} the checkout token. The rest were dropped with ` +
          'their markup — usually a repeating region collapsed to one item — so no unlabelled button ships.',
      ),
    );
  } else if (input.originalCtaCount > 0 && ctaCount > input.originalCtaCount) {
    findings.push(
      warn(
        'CTA_COUNT_EXTRA',
        `${ctaCount} buy buttons were labelled where ${input.originalCtaCount} were detected. The extra ones ` +
          "point at the seller's checkout, so this is worth a look but not a problem.",
      ),
    );
  }

  // ── the template owner's PRICE must not survive ───────────────────────────
  // Requiring a {{PRICE}} label outright was wrong: a template may legitimately
  // show no price, and a lead-magnet page could then never be extracted however
  // cleanly it cloned. What actually matters is narrower and more serious — a
  // price the seller did not set, left on a page that takes money. A buyer who
  // reads $47 and is charged $27 is the good case; the reverse is a complaint.
  if (!html.includes(token('PRICE'))) {
    const leftover = findPriceLikeText(html);
    if (leftover.length > 0) {
      findings.push(
        warn(
          'PRICE_NOT_LABELLED',
          `No node was labelled ${token('PRICE')}, but the page still shows ${leftover.length} price-like ` +
            `value(s) (${leftover.slice(0, 3).join(', ')}…). Those are the template owner's ` +
            "figures. Whether any of them is the PRODUCT'S price cannot be told from the text alone — on a " +
            'page about saving money, most are the subject of the copy — so this is checked again at publish ' +
            "time against the seller's actual price.",
        ),
      );
    }
  }

  // ── nothing may still belong to the template's owner ──────────────────────
  findings.push(...residualSourceLinks(html, input.sourceHost));

  // ── safety: none of this should survive cleaning, so any hit is a bug ─────
  findings.push(...safetyFindings(html));

  if (input.sectionCount < MIN_SECTIONS) {
    findings.push(
      blocker(
        'TOO_FEW_SECTIONS',
        `Only ${input.sectionCount} sections were found. This is usually an app shell that never finished ` +
          'rendering, or a page behind a bot challenge.',
      ),
    );
  }

  return findings.some((f) => f.severity === 'BLOCKER') ? Result.fail(findings) : Result.ok<void, Finding[]>(undefined);
}

export interface BoundValidationInput {
  html: string;
  /**
   * Every checkout URL this page must carry — one per product.
   *
   * A list rather than a single link because a multi-book page sells several
   * products with different links, and a check that only looked at the featured
   * book's would happily pass a page whose other two buttons go nowhere.
   */
  checkoutUrls: string[];
  sourceHost: string;
  /** From the template — how many buy buttons this page must have. */
  expectedCtaCount: number;
  /**
   * Price-like strings the template carried that were never labelled.
   *
   * Checked HERE rather than at extraction, because only here is the seller's
   * own price known. A figure that is merely the copy's subject survives
   * harmlessly; one sitting where a price belongs is a page advertising an
   * amount the seller never set.
   */
  templatePrices?: string[] | undefined;
}

/**
 * Validates the FINISHED page, after substitution.
 *
 * v1 ran every check before substitution and none after, so a page could ship
 * with leaked slot tokens, empty sections, or markup that substitution itself
 * broke. This is the check that was missing.
 */
export function validateBoundPage(input: BoundValidationInput): Finding[] {
  const findings: Finding[] = [];
  const { html } = input;

  const residual = html.match(/\{\{[^}]{0,60}\}\}/);
  if (residual) {
    findings.push(blocker('RESIDUAL_TOKEN', `${residual[0]} would ship to a buyer as literal braces.`));
  }

  const urls = input.checkoutUrls.filter(Boolean);
  if (urls.length > 0) {
    const missing = urls.filter((url) => !html.includes(url));
    if (missing.length === urls.length) {
      findings.push(blocker('CHECKOUT_MISSING', 'No buy button on the finished page points at a checkout URL.'));
    } else if (missing.length > 0) {
      // The specific defect this catches: a three-book page where one card's
      // link never got bound, so that book has a button a buyer can press and
      // nothing happens.
      findings.push(
        blocker(
          'CHECKOUT_INCOMPLETE',
          `${missing.length} of ${urls.length} products have no buy link on the finished page.`,
        ),
      );
    }

    // Only meaningful when every button carries the SAME link. On a multi-book
    // page the count per link is one per card by construction.
    if (urls.length === 1 && input.expectedCtaCount > 0) {
      const hits = occurrences(html, urls[0] as string);
      if (hits !== input.expectedCtaCount) {
        findings.push(
          warn(
            'CHECKOUT_COUNT_DRIFT',
            `The template has ${input.expectedCtaCount} buy buttons but the page carries ${hits} checkout links.`,
          ),
        );
      }
    }
  }

  // The worst possible defect on a cloned page: a live buy button still
  // pointing at the site the template came from.
  findings.push(...residualSourceLinks(html, input.sourceHost));
  findings.push(...safetyFindings(html));

  // ── the template owner's price must not be what a buyer reads ─────────────
  // Only the ones adjacent to a buy button matter. A savings figure in a
  // paragraph is the copy talking; the same string beside the checkout link is
  // the page quoting a price nobody set.
  for (const price of input.templatePrices ?? []) {
    if (!html.includes(price)) continue;
    const at = html.indexOf(price);
    const nearby = html.slice(Math.max(0, at - 600), at + 600);
    const nearCheckout = input.checkoutUrls.some((url) => nearby.includes(url));
    if (nearCheckout) {
      findings.push(
        blocker(
          'TEMPLATE_PRICE_BESIDE_CTA',
          `"${price}" came from the template and still sits beside a buy button. A buyer would read it as ` +
            'the price and be charged something else.',
        ),
      );
    }
  }

  // ── accessibility ─────────────────────────────────────────────────────────
  const h1s = occurrences(html, '<h1');
  if (h1s === 0) findings.push(warn('NO_H1', 'The page has no <h1>.'));
  if (h1s > 1) findings.push(warn('MULTIPLE_H1', `The page has ${h1s} <h1> elements; one is correct.`));

  const imagesWithoutAlt = [...html.matchAll(/<img\b[^>]*>/gi)].filter((m) => !/\balt\s*=/i.test(m[0])).length;
  if (imagesWithoutAlt > 0) {
    findings.push(warn('IMG_NO_ALT', `${imagesWithoutAlt} image(s) have no alt text.`));
  }

  const emptyHref = occurrences(html, 'href=""');
  if (emptyHref > 0) findings.push(blocker('EMPTY_HREF', `${emptyHref} link(s) have an empty href.`));

  return findings;
}

/** Any http(s) link or asset still pointing at the template's own site. */
function residualSourceLinks(html: string, sourceHost: string): Finding[] {
  if (!sourceHost) return [];
  const host = sourceHost.replace(/^www\./, '');
  const re = new RegExp(`(?:href|src)\\s*=\\s*["']https?://(?:www\\.)?${escapeRegex(host)}`, 'gi');
  const hits = [...html.matchAll(re)];
  if (hits.length === 0) return [];
  return [
    blocker(
      'SOURCE_LINK_SURVIVED',
      `${hits.length} link(s) or asset(s) still point at ${sourceHost}. A published page must not send ` +
        "traffic — or a buyer — to the template owner's site.",
    ),
  ];
}

/**
 * Executable content and third-party requests. Cleaning removes all of this, so
 * a hit here means the cleaner missed something rather than that a model
 * misbehaved — which is why every one is a blocker.
 */
function safetyFindings(html: string): Finding[] {
  const findings: Finding[] = [];
  if (/<script\b/i.test(html)) findings.push(blocker('SCRIPT_SURVIVED', 'A <script> survived cleaning.'));
  if (/<(iframe|object|embed)\b/i.test(html)) {
    findings.push(blocker('EMBED_SURVIVED', 'An <iframe>, <object> or <embed> survived cleaning.'));
  }
  if (/<form\b/i.test(html)) findings.push(blocker('FORM_SURVIVED', 'A <form> survived cleaning.'));
  if (/\son[a-z]+\s*=\s*["']/i.test(html)) {
    findings.push(blocker('INLINE_HANDLER', 'An inline event handler (onclick, onload…) survived cleaning.'));
  }
  if (/javascript:/i.test(html)) findings.push(blocker('JS_URL', 'A javascript: URL survived cleaning.'));
  return findings;
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
