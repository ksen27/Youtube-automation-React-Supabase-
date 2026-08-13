import { CORE_PLACEHOLDERS, REPEATER_PLACEHOLDERS } from '../../domain/landing/PlaceholderVocabulary';
import type { InventoryNode } from '../ports/services/TemplateCapturer';

/**
 * Labels which nodes on an already-cloned page hold product content.
 *
 * This is the ONLY call in the pipeline that looks at the template, and it
 * cannot change it. The model is given an outline — node ids, tags, positions,
 * text — and returns a list of `{nodeId, placeholder}`. It never sees markup and
 * never emits markup, so a hallucinated id resolves to nothing and a malformed
 * response fails schema validation. Neither can affect the page.
 *
 * That is the structural difference from `LandingLayoutPrompt`, which this
 * replaces. That prompt spent 470 lines trying to talk a model into reproducing
 * a design it was simultaneously being given a competing spec for. Nothing here
 * needs saying twice, because the design is not up for discussion — it already
 * exists in the DOM this call is describing.
 */
export const TemplateAnnotationPrompt = {
  build(input: {
    sourceUrl: string;
    title: string;
    inventory: InventoryNode[];
    /** Repeating regions already detected mechanically; the model names them. */
    repeaterContainers: Array<{ containerTplId: string; itemCount: number; sampleText: string }>;
    /** Corrections a human made previously, re-applied on a re-extraction. */
    overrides?: Array<{ placeholder: string; matchText: string }> | undefined;
    /** Problems from a previous attempt, for one repair round. */
    repairErrors?: string[] | undefined;
  }) {
    const core = Object.entries(CORE_PLACEHOLDERS)
      .map(([key, spec]) => `  ${key}  (${spec.kind}${spec.required ? ', required' : ''}) — ${spec.purpose}`)
      .join('\n');

    const repeaters = Object.entries(REPEATER_PLACEHOLDERS)
      .map(([key, spec]) => `  ${key}  fields: ${spec.fields.join(', ')} — ${spec.purpose}`)
      .join('\n');

    return {
      system: [
        'You label nodes on an existing web page so its content can be replaced.',
        '',
        'The page already exists and is NOT being redesigned. You do not write HTML,',
        'CSS, layout, spacing or structure. You return labels for node ids, and',
        'deterministic code applies them. Nothing you write reaches the page except',
        'as a choice of which node holds which kind of content.',
        '',
        'Return ONLY this JSON, no prose around it:',
        '  { "map": [ { "nodeId": "n17", "placeholder": "HERO_TITLE", "maxChars": 34 } ],',
        '    "repeaters": [ { "containerTplId": "n40", "key": "BENEFITS" } ] }',
        '',
        'RULES',
        '',
        '1. nodeId MUST be one of the ids in the inventory. Ids you invent are',
        '   discarded, and the node they were meant for keeps the template owner\'s',
        '   own words — so guessing is worse than omitting.',
        '',
        '2. maxChars = the node\'s current character count × 1.15, rounded up. The',
        "   page's CSS was tuned to the words that are there now. This is a measured",
        '   budget, not a preference.',
        '',
        // SCOPE: deliberately the conservative rule, matching the sibling
        // ebookgenerator project this feature came from. The maximalist version
        // that stood here — "COVERAGE IS THE WHOLE JOB", sweep every text node,
        // SECTION: tokens for most of a long page — produced answers several
        // times larger, and on a long sales page the call ran out of output
        // budget, was discarded as truncated, and the repair round dropped the
        // cover label and failed the extraction outright. Fuller coverage is
        // worth having, but not at the cost of templates that will not extract:
        // an unlabelled node keeps the original wording, which is visible and
        // fixable, whereas a template that never extracts leaves nothing to fix.
        // The money rules below (4 and 5b) stay maximal on purpose — those are
        // the leftovers that mislead a buyer rather than merely read wrong.
        '3. Label ONLY nodes whose content is about the PRODUCT — what is being sold,',
        '   who wrote it, what it costs, what the reader gets. Leave alone:',
        '     · navigation and menu labels',
        '     · privacy / terms links in the navigation',
        '     · section labels that describe the page rather than the product',
        '       ("Frequently asked questions" is furniture; the questions are content)',
        '     · anything you are unsure about',
        '   An unlabelled node keeps the original wording, which is visible and',
        '   fixable. A wrongly labelled one silently replaces the wrong text.',
        '',
        '4. Each core placeholder may be used at most once, EXCEPT CHECKOUT_URL,',
        '   CTA_TEXT, PRICE, COMPARE_AT_PRICE, BOOK_COVER and BOOK_COVER_ALT —',
        '   a sales page repeats its buy button, its price and its cover by design,',
        '   and EVERY occurrence must be labelled. A missed buy button leaves a live',
        '   link to the original site; a missed price advertises a figure the new',
        '   seller never set; a missed cover image shows the original seller\'s book,',
        '   or renders as an empty gap once the copied asset is dropped.',
        '',
        '5. For a repeating region, label the FIRST item only and use the field form',
        '   KEY.field — e.g. BENEFITS.title, BENEFITS.body. The remaining items are',
        '   removed and regenerated from the first, so labelling them does nothing.',
        '',
        '5b. EVERY currency amount on the page MUST be labelled. A price the new',
        '   seller did not set is not a cosmetic leftover: it sits on a page with a',
        '   live buy button, so a buyer reads it and is charged something else.',
        '     · the amount charged        → PRICE',
        '     · a struck-through "was"    → COMPARE_AT_PRICE',
        '   Sales pages repeat their price — in the hero, in an offer stack, in a',
        '   sticky bar, beside every button. Both tokens may therefore be used MORE',
        '   THAN ONCE (this is the exception to rule 4, alongside CTA_TEXT and',
        '   CHECKOUT_URL), and every occurrence must be labelled.',
        '   Label the SMALLEST node holding just the amount. Where one node holds',
        '   two amounts together ("$57 $37"), label the node that holds each one',
        '   separately if the markup allows it; if it does not, label the whole node',
        '   PRICE — a single correct price beats two wrong ones.',
        '   A currency amount that is genuinely CONTENT, not the product\'s price —',
        '   "a delayed flight can be worth €600", "a $22 tool" — is left alone: it',
        '   is a claim in the copy, and the copy is replaced anyway.',
        '',
        '6. The FOOTER DISCLAIMER — the copyright line and the block of small print',
        '   at the very bottom (refund terms, "results vary", company details) — MUST',
        "   be labelled FOOTER_LEGAL. It is replaced with the new seller's own text.",
        "   Leaving it unlabelled publishes the original owner's refund policy as if",
        "   it were the new seller's, which is a contractual claim they never made.",
        '   Label the smallest element that CONTAINS the whole disclaimer block.',
        '',
        '7. Anything the vocabulary does not cover, but which is clearly product',
        '   content, gets an extended token: SECTION:<nodeId>.heading, ',
        '   SECTION:<nodeId>.body. Use these freely — a template section with no',
        '   token keeps the original page\'s words about the original page\'s product.',
        '',
        'THE VOCABULARY',
        '',
        'Single-value tokens:',
        core,
        '',
        'Repeating regions (label the first item, using KEY.field):',
        repeaters,
      ].join('\n'),

      user: [
        `Source: ${input.sourceUrl}`,
        `Title: ${input.title}`,
        '',
        ...(input.repairErrors && input.repairErrors.length > 0
          ? [
              'YOUR PREVIOUS ANSWER HAD PROBLEMS. Fix exactly these and return the whole',
              'map again:',
              ...input.repairErrors.map((e) => `  · ${e}`),
              '',
            ]
          : []),
        ...(input.overrides && input.overrides.length > 0
          ? [
              'A human has previously corrected this template. Honour these decisions —',
              'find the node whose text matches and label it as stated:',
              ...input.overrides.map((o) => `  · "${o.matchText}" → ${o.placeholder}`),
              '',
            ]
          : []),
        ...(input.repeaterContainers.length > 0
          ? [
              '=== REPEATING REGIONS DETECTED ===',
              'These containers hold structurally identical children. Name each one with',
              'a repeater key from the vocabulary, or omit it if none fits.',
              ...input.repeaterContainers.map(
                (r) => `  ${r.containerTplId}: ${r.itemCount} items — first reads "${r.sampleText}"`,
              ),
              '',
            ]
          : []),
        '=== NODE INVENTORY ===',
        JSON.stringify(input.inventory),
      ].join('\n'),
    };
  },
};
