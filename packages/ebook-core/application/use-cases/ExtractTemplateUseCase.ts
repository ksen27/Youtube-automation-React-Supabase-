import { z } from 'zod';
import { Result } from '../../domain/shared/Result';
import {
  CORE_PLACEHOLDERS,
  REPEATER_PLACEHOLDERS,
  isExtendedKey,
  kindFor,
  splitRepeaterField,
} from '../../domain/landing/PlaceholderVocabulary';
import {
  LANDING_PIPELINE_VERSION,
  type ExtractionReport,
  type Finding,
  type PlaceholderEntry,
  type RepeaterEntry,
  type StoredLandingTemplate,
} from '../../domain/landing/TemplateManifest';
import { findPriceLikeText, validateTemplate } from '../landing/templateContract';
import { TemplateAnnotationPrompt } from '../prompts/TemplateAnnotationPrompt';
import { parseJsonCompletion } from '../prompts/parse';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { CapturedTemplate, InventoryNode, TemplateCapturer } from '../ports/services/TemplateCapturer';
import type { PageDiffer } from '../ports/services/PageDiffer';
import type { LandingTemplateRepository } from '../ports/repositories/LandingTemplateRepository';
import type { TemplateArtifactStore } from '../ports/services/TemplateArtifactStore';
import type { IdGenerator } from '../ports/IdGenerator';
import type { Clock } from '../ports/Clock';

/**
 * The annotation model's only output shape.
 *
 * Ids and names — nothing that could be markup. A response that does not fit
 * this fails schema validation and the extraction retries; a response that fits
 * but names nodes that do not exist has those entries dropped. There is no
 * third case, which is what makes "the AI cannot break the layout" a property
 * of the system rather than an instruction in a prompt.
 */
const AnnotationEntry = z.object({
  nodeId: z.string(),
  placeholder: z.string(),
  // `nullish`, not `optional`: the model returns an explicit null when it has
  // no opinion, and `optional` rejects null. Four nulls in a fourteen-entry map
  // failed the whole extraction — for a field that is ADVISORY, since
  // `budgetFor` measures the real budget from the node's own text and only
  // accepts this number when it agrees with the measurement.
  maxChars: z.number().nullish(),
});

const AnnotationRepeater = z.object({ containerTplId: z.string(), key: z.string() });

/**
 * Drops entries that do not parse, rather than failing the whole response.
 *
 * One malformed row out of forty should not discard the other thirty-nine. It
 * is safe to be lenient here because nothing downstream trusts this list: ids
 * that name no node are dropped, the checkout guard runs regardless of what the
 * model said, and `validateTemplate` still refuses a template that ends up
 * missing a required placeholder. A dropped entry costs one unlabelled node,
 * which is visible and fixable; a rejected response costs the entire run.
 */
function lenientArray<S extends z.ZodTypeAny>(item: S) {
  return z
    .array(z.unknown())
    .default([])
    .transform((rows) =>
      rows
        .map((row) => item.safeParse(row))
        .filter((r): r is { success: true; data: z.output<S> } => r.success)
        .map((r) => r.data),
    );
}

const AnnotationSchema = z.object({
  map: lenientArray(AnnotationEntry),
  repeaters: lenientArray(AnnotationRepeater),
});

type Annotation = z.infer<typeof AnnotationSchema>;

/**
 * The repair pass, plus whatever the first pass labelled that it left alone.
 *
 * `repair` wins every node and every container it names — it saw the errors and
 * is the corrected answer. `earlier` only fills gaps, so a second sweep that
 * came back thinner cannot lose labels the first one got right. The result is
 * resolved as a single annotation, so single-use rules and the vocabulary check
 * apply to the union rather than to either half.
 */
function mergeAnnotations(repair: Annotation, earlier: Annotation): Annotation {
  const labelledNodes = new Set(repair.map.map((e) => e.nodeId));
  const namedContainers = new Set(repair.repeaters.map((r) => r.containerTplId));
  return {
    map: [...repair.map, ...earlier.map.filter((e) => !labelledNodes.has(e.nodeId))],
    repeaters: [...repair.repeaters, ...earlier.repeaters.filter((r) => !namedContainers.has(r.containerTplId))],
  };
}

/** Copy may run 15% longer than the words the template's CSS was tuned to. */
const LENGTH_HEADROOM = 1.15;

/** Below this, a slot is too small to write anything meaningful into. */
const MIN_MAX_CHARS = 12;

/**
 * How far the cleaned page may drift from the captured original before the
 * template is not worth building on.
 *
 * This is the honest measure of what cloning costs: scripts are stripped, so
 * anything the template drove with JavaScript stops. A page whose reveals or
 * carousel accounted for a fifth of its pixels is a page the seller should be
 * told about before they build on it, not after.
 */
const MAX_CLEANING_LOSS = 0.2;

/** A failed run, carrying whatever it managed to measure before stopping. */
interface ExtractionFailure {
  reason: string;
  report: ExtractionReport | null;
  /**
   * What the run had worked out before it stopped.
   *
   * A failed row used to store a blank record, so `placeholderCount: 0` and
   * `repeaterCount: 0` meant "we did not save them" rather than "we found
   * none" — and there was no way to tell those apart from outside. Diagnosing a
   * failure needs to know which of the two it was.
   */
  placeholders?: PlaceholderEntry[] | undefined;
  repeaters?: RepeaterEntry[] | undefined;
}

export interface ExtractTemplateInput {
  ownerId: string;
  sourceUrl: string;
  /**
   * The user's assertion that they may copy this template.
   *
   * Required, and recorded. Cloning a site wholesale is a different act from
   * being inspired by one, and the system is not entitled to make that call on
   * the seller's behalf.
   */
  attestOwnership: boolean;
  /** Re-extract even when a template already exists at this pipeline version. */
  force?: boolean | undefined;
  /**
   * The id the row should take.
   *
   * Supplied by the API so the id it returns to the caller is the id the row
   * actually gets. Without it the caller was handed an id that was never used —
   * the use case minted its own — so polling for the template it had just
   * queued always came back empty.
   */
  templateId?: string | undefined;
}

/**
 * Clones a template site and turns it into a fillable template.
 *
 * Stages 1–4: capture in a real browser, clean, label, parameterise. The only
 * model call is the labelling one, and it produces a mapping that deterministic
 * code applies — nothing here asks a model to write HTML, CSS, or layout.
 */
export class ExtractTemplateUseCase {
  constructor(
    private readonly templates: LandingTemplateRepository,
    private readonly capturer: TemplateCapturer,
    private readonly artifacts: TemplateArtifactStore,
    private readonly differ: PageDiffer,
    private readonly ai: AiTextGenerator,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: ExtractTemplateInput): Promise<Result<{ templateId: string; report: ExtractionReport }>> {
    if (!input.attestOwnership) {
      return Result.fail(
        'Confirm you have the right to use this template before it can be copied. The system makes a complete ' +
          "copy of the page, which is not the same as taking inspiration from it.",
      );
    }

    const sourceUrl = input.sourceUrl.trim();
    if (!/^https?:\/\//i.test(sourceUrl)) return Result.fail('The template URL must start with http:// or https://');

    const existing = await this.templates.findCurrent(input.ownerId, sourceUrl, LANDING_PIPELINE_VERSION);
    if (existing && existing.state === 'READY' && !input.force) {
      return Result.ok({ templateId: existing.id, report: existing.report ?? emptyReport() });
    }

    const templateId = input.templateId ?? this.ids.uuid();
    const revision = (existing?.revision ?? 0) + 1;
    const created = await this.templates.create({
      id: templateId,
      ownerId: input.ownerId,
      sourceUrl,
      pipelineVersion: LANDING_PIPELINE_VERSION,
      revision,
    });
    if (created.isFail()) return Result.fail(created.error);

    const outcome = await this.run(templateId, sourceUrl, existing);
    if (outcome.isFail()) {
      await this.templates.save({
        ...blank(templateId, input.ownerId, sourceUrl, revision),
        state: 'FAILED',
        failureReason: outcome.error.reason,
        // Keep the measurements. Without them a failed row says only that it
        // failed, and the numbers that explain WHY are gone.
        report: outcome.error.report,
        placeholders: outcome.error.placeholders ?? [],
        repeaters: outcome.error.repeaters ?? [],
      });
      return Result.fail(outcome.error.reason);
    }

    const { template, report } = outcome.value;
    await this.templates.save({
      ...template,
      id: templateId,
      ownerId: input.ownerId,
      sourceUrl,
      revision,
      state: 'READY',
      report,
    });
    return Result.ok({ templateId, report });
  }

  private async run(
    templateId: string,
    sourceUrl: string,
    previous: StoredLandingTemplate | null,
  ): Promise<Result<{ template: StoredLandingTemplate; report: ExtractionReport }, ExtractionFailure>> {
    // ── STAGE 1–2: capture and clean ─────────────────────────────────────────
    const captured = await this.capturer.capture(sourceUrl);
    if (captured.isFail()) return Result.fail({ reason: captured.error, report: null });
    const page = captured.value;

    const findings: Finding[] = [];
    const notes = [...page.notes];
    /** Price-like strings the template kept; judged at bind time, not here. */
    let residualPrices: string[] = [];

    /**
     * What was measured so far, for a run that does not reach the end.
     *
     * Written on failure as well as success. The first real extraction failed
     * validation and reported `cleaningLoss: null` — the single most useful
     * diagnostic, computed minutes earlier and then thrown away because the
     * failure path stored a blank row. A failed extraction is exactly when
     * those numbers are needed.
     */
    const partial = (): ExtractionReport => ({
      findings,
      cleaningLoss,
      droppedImages: [],
      fontFidelity: 'none',
      lostFamilies: [],
      assetBytes: 0,
      sectionCount: page.sections.length,
      notes,
      detectedRepeaters: page.repeaters.map((r) => ({
        containerTplId: r.containerTplId,
        itemCount: r.originalCount,
        flexibleCount: r.flexibleCount,
      })),
      residualPrices,
    });

    // What cleaning cost, measured rather than assumed.
    const cleaningLoss: ExtractionReport['cleaningLoss'] = [];
    const diffed = await this.differ.compare({ baseline: page.baselineShots, candidate: page.cleanedShots });
    if (diffed.isOk()) {
      for (const result of diffed.value) {
        cleaningLoss.push({ width: result.width, mismatchRatio: result.mismatchRatio });
        if (result.mismatchRatio > MAX_CLEANING_LOSS) {
          findings.push({
            severity: 'BLOCKER',
            code: 'CLEANING_LOSS',
            message:
              `Removing scripts changed ${Math.round(result.mismatchRatio * 100)}% of the page at ` +
              `${result.width}px. This template's appearance depends on JavaScript that cannot be ` +
              'republished — most often a scroll-reveal library or a carousel.',
          });
        }
      }
    } else {
      notes.push(`The cleaning-loss check could not run: ${diffed.error}`);
    }

    // ── STAGE 2: store the artifacts and re-host the assets ───────────────────
    const stored = await this.artifacts.storeTemplate({
      templateId,
      originalHtml: page.originalHtml,
      cleanHtml: page.cleanHtml,
      css: page.css,
      baseUrl: page.finalUrl,
      assets: page.assets,
      baselineShots: page.baselineShots,
      typography: page.typography,
    });
    if (stored.isFail()) return Result.fail({ reason: stored.error, report: partial() });
    if (stored.value.unresolvedUrls.length > 0) {
      notes.push(
        `${stored.value.unresolvedUrls.length} stylesheet asset(s) could not be re-hosted; those decorations ` +
          'are absent rather than loaded from the template owner’s server.',
      );
    }
    if (stored.value.fontFidelity === 'degraded') {
      // Named rather than summarised: "typography will differ" gave the seller
      // nothing to act on, while knowing it is the display face that was lost
      // tells them whether the page is still worth publishing.
      const lost = stored.value.lostFamilies;
      notes.push(
        (lost.length > 0
          ? `${lost.slice(0, 4).join(', ')}${lost.length > 4 ? ` and ${lost.length - 4} more` : ''} could not be `
          : 'Some of the template’s webfonts could not be ') +
          'legally re-hosted, so the type falls back to the nearest available faces. Typography will differ ' +
          'from the original.',
      );
    }

    // ── STAGE 3: label ───────────────────────────────────────────────────────
    const annotated = await this.annotate(templateId, page, previous);
    if (annotated.isFail()) return Result.fail({ reason: annotated.error, report: partial() });

    const placeholders = annotated.value.placeholders;
    const repeaters = annotated.value.repeaters;
    findings.push(...annotated.value.findings);

    // NO COVERAGE RATIO. A warning stood here demanding 35% of text nodes be
    // labelled, and it was the companion of the maximalist annotation rule that
    // has now been narrowed back to the sibling project's conservative one (see
    // TemplateAnnotationPrompt rule 3). Under a prompt that deliberately leaves
    // uncertain nodes alone, that ratio fires on healthy templates, and a
    // warning that cries wolf on the normal case teaches the seller to skip the
    // whole report. What the unlabelled remainder actually costs — the original
    // wording surviving in places — is visible on the template review screen,
    // node by node, which is also where it can be corrected.

    // ── STAGE 4: parameterise ────────────────────────────────────────────────
    const parameterised = await this.capturer.parameterise({
      cleanHtml: stored.value.cleanHtml,
      placeholders,
      repeaters,
    });
    if (parameterised.isFail()) return Result.fail({ reason: parameterised.error, report: partial() });

    if (parameterised.value.droppedIds.length > 0) {
      // The safety property, visible: an id that named nothing did nothing.
      findings.push({
        severity: 'WARN',
        code: 'NODES_DROPPED',
        message:
          `${parameterised.value.droppedIds.length} labelled node(s) no longer existed and were skipped. ` +
          'Those parts of the page keep the original wording.',
      });
    }

    const applied = new Set(parameterised.value.appliedIds);
    const kept = placeholders.filter((p) => applied.has(p.tplId));

    // ── validate ─────────────────────────────────────────────────────────────
    const host = hostOf(page.finalUrl);
    const contract = validateTemplate({
      html: parameterised.value.html,
      placeholders: kept,
      repeaters: repeaters.filter((r) => r.key),
      sourceHost: host,
      originalCtaCount: page.ctaIds.length,
      sectionCount: page.sections.length,
    });
    if (contract.isFail()) findings.push(...contract.error);
    // Every figure, not the three the warning names. The publish-time gate
    // checks this list, and a truncated one would wave through the very figure
    // that mattered.
    if (!parameterised.value.html.includes('{{PRICE}}')) {
      residualPrices = findPriceLikeText(parameterised.value.html);
    }

    findings.push(...brandLeakFindings(parameterised.value.html, host, page.title));

    const blockers = findings.filter((f) => f.severity === 'BLOCKER');
    if (blockers.length > 0) {
      return Result.fail({
        reason: blockers.map((f) => f.message).join(' · '),
        report: partial(),
        placeholders: kept,
        repeaters: repeaters.filter((r) => r.key),
      });
    }

    // Only assets the parameterised page still references are worth keeping —
    // the template owner's own product photography becomes a placeholder, and
    // storing or deploying it would be republishing their asset.
    const pruned = await this.artifacts.pruneAssets({
      templateId,
      html: parameterised.value.html,
      css: stored.value.css,
      assets: stored.value.assets,
    });

    const finalHtml = await this.artifacts.storeParameterised({
      templateId,
      html: parameterised.value.html,
      css: stored.value.css,
    });
    if (finalHtml.isFail()) return Result.fail({ reason: finalHtml.error, report: partial() });

    const report: ExtractionReport = {
      findings,
      cleaningLoss,
      droppedImages: page.contentImages
        .filter((img) => !kept.some((p) => p.tplId === img.tplId))
        .map((img) => ({
          tplId: img.tplId,
          sourceUrl: img.sourceUrl,
          rect: { x: 0, y: 0, width: img.width, height: img.height },
        })),
      fontFidelity: stored.value.fontFidelity,
      residualPrices,
      detectedRepeaters: page.repeaters.map((r) => ({
        containerTplId: r.containerTplId,
        itemCount: r.originalCount,
        flexibleCount: r.flexibleCount,
      })),
      lostFamilies: stored.value.lostFamilies,
      assetBytes: pruned.reduce((total, a) => total + a.byteSize, 0),
      sectionCount: page.sections.length,
      notes,
    };

    return Result.ok({
      template: {
        id: templateId,
        ownerId: '',
        sourceUrl,
        state: 'READY',
        name: page.title || hostOf(page.finalUrl),
        originalHtmlPath: stored.value.originalHtmlPath,
        cleanHtmlPath: finalHtml.value.cleanHtmlPath,
        cssBundlePath: finalHtml.value.cssBundlePath,
        placeholders: kept,
        repeaters: repeaters.filter((r) => r.key),
        theme: page.theme,
        typography: page.typography,
        responsive: {
          widths: page.baselineShots.map((s) => s.width),
          breakpoints: stored.value.breakpoints,
          sections: page.sections,
        },
        baselineShots: stored.value.baselineShotPaths,
        overrides: previous?.overrides ?? [],
        report,
        failureReason: null,
        pipelineVersion: LANDING_PIPELINE_VERSION,
        revision: 0,
        capturedAt: this.clock.now(),
      },
      report,
    });
  }

  /**
   * The one model call, plus the deterministic guards that outrank it.
   *
   * The guards run AFTER the model and override it. That order is deliberate:
   * a missed buy button is a live anchor still pointing at the template owner's
   * store, which is the worst thing a cloned page can ship, and it is not a
   * judgement call — an href either matches a payment processor or it does not.
   */
  private async annotate(
    templateId: string,
    page: CapturedTemplate,
    previous: StoredLandingTemplate | null,
  ): Promise<Result<{ placeholders: PlaceholderEntry[]; repeaters: RepeaterEntry[]; findings: Finding[] }>> {
    const byId = new Map(page.inventory.map((n) => [n.tplId, n]));
    const findings: Finding[] = [];
    let repairErrors: string[] | undefined;
    /**
     * The first attempt's labels, kept so the repair pass ADDS to them.
     *
     * The repair used to replace them wholesale, and a second pass is a fresh
     * sweep of a long inventory rather than an edit of the first: it fixes the
     * one entry that erred and silently drops a dozen it had labelled
     * correctly. The observed result was a re-copied template that labelled
     * FEWER prices and repeater fields than the capture it replaced — the page
     * came back with the template's own "$67" beside a buy button and empty
     * benefit cards, and re-copying looked like it made things worse.
     *
     * Only entries for nodes the repair did not touch are carried over, and the
     * merged map goes through resolveAnnotation as one, so single-use rules are
     * enforced against the whole thing rather than per attempt.
     */
    let firstPass: Annotation | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = TemplateAnnotationPrompt.build({
        sourceUrl: page.finalUrl,
        title: page.title,
        inventory: page.inventory,
        repeaterContainers: page.repeaters.map((r) => ({
          containerTplId: r.containerTplId,
          itemCount: r.originalCount,
          sampleText: byId.get(r.itemTplId)?.text ?? '',
        })),
        ...(previous && previous.overrides.length > 0
          ? {
              overrides: previous.overrides
                .filter((o) => o.action === 'relabel' && o.matchText)
                .map((o) => ({ placeholder: o.replacement ?? o.placeholder, matchText: o.matchText ?? '' })),
            }
          : {}),
        ...(repairErrors ? { repairErrors } : {}),
      });

      const completion = await this.ai.generate({
        // Sonnet: this is structured extraction against a supplied list, not
        // design judgement. Nothing in this pipeline is the 30k-token authoring
        // call that justified Opus in the previous one.
        model: 'claude-sonnet-4-6',
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        // One entry per labelled node, and rule 3 asks the model to account for
        // EVERY product node on the page — so the answer scales with the
        // template, not with some fixed idea of "enough labels". A long sales
        // page (22k tokens of inventory) hit the old 8k ceiling exactly, and
        // the truncation path below then asked for FEWER labels, which is how a
        // template came back with no cover labelled at all and failed
        // extraction outright. The budget has to fit the page.
        maxTokens: 24_000,
        cacheControl: { systemPrefix: true },
        metadata: { projectId: templateId, stage: 'landing-template-annotate' },
      });
      if (completion.isFail()) return Result.fail(`Template annotation failed: ${completion.error.type}`);
      if (completion.value.stopReason === 'max_tokens') {
        // Which labels to sacrifice is not the model's choice to make freely:
        // dropping a cover or a buy button fails the extraction (or ships the
        // template owner's artwork), whereas dropping a decorative caption
        // costs one unlabelled line.
        repairErrors = [
          'Your response was cut off, so it could not be used. Return a SHORTER map — but keep every ' +
            'BOOK_COVER (or <KEY>.coverSrc), CHECKOUT_URL, PRICE and COMPARE_AT_PRICE label, and every ' +
            'repeater key. Drop decorative and secondary text instead; an unlabelled caption costs one line, ' +
            'a missing cover or buy button costs the whole template.',
        ];
        continue;
      }

      const parsed = parseJsonCompletion(completion.value.text, AnnotationSchema);
      if (parsed.isFail()) {
        repairErrors = [`Your response was not valid JSON in the required shape: ${parsed.error}`];
        continue;
      }

      const annotation = firstPass ? mergeAnnotations(parsed.value, firstPass) : parsed.value;
      const resolved = resolveAnnotation(annotation, page, byId);
      if (resolved.errors.length > 0 && attempt === 0) {
        repairErrors = resolved.errors;
        firstPass = parsed.value;
        continue;
      }
      findings.push(...resolved.findings);
      return Result.ok({ placeholders: resolved.placeholders, repeaters: resolved.repeaters, findings });
    }

    return Result.fail(
      `The template could not be labelled after two attempts: ${(repairErrors ?? ['unknown reason']).join('; ')}`,
    );
  }
}

/**
 * Turns the model's answer into a placeholder map, discarding anything that
 * does not resolve and forcing the checkout labels that are not negotiable.
 */
function resolveAnnotation(
  annotation: z.infer<typeof AnnotationSchema>,
  page: CapturedTemplate,
  byId: Map<string, InventoryNode>,
): {
  placeholders: PlaceholderEntry[];
  repeaters: RepeaterEntry[];
  findings: Finding[];
  errors: string[];
} {
  const findings: Finding[] = [];
  const errors: string[] = [];
  const placeholders: PlaceholderEntry[] = [];
  const claimed = new Map<string, string>();

  for (const entry of annotation.map) {
    const node = byId.get(entry.nodeId);
    if (!node) continue; // an invented id names nothing and does nothing

    const kind = kindFor(entry.placeholder);
    if (!kind) {
      errors.push(`"${entry.placeholder}" is not a token in the vocabulary.`);
      continue;
    }

    // A `src` label on a text node, or a `text` label on an image, is a mapping
    // the DOM cannot honour.
    if ((kind === 'src' || kind === 'alt') && node.tag !== 'img') {
      errors.push(`${entry.placeholder} was put on a <${node.tag}>, but it can only go on an image.`);
      continue;
    }
    if (kind === 'href' && node.tag !== 'a') {
      errors.push(`${entry.placeholder} was put on a <${node.tag}>, but it can only go on a link.`);
      continue;
    }

    // Single-use core tokens, with the exemptions below — all of them things a
    // sales page repeats by design:
    //   CHECKOUT_URL / CTA_TEXT — every buy button, or one links to the
    //     original site.
    //   PRICE / COMPARE_AT_PRICE — the price appears in the hero, again in the
    //     offer stack, often again in a sticky bar. Rejecting the second
    //     occurrence left it as literal template text ("$57 $37" baked into the
    //     markup), so a page whose checkout charges $20 still advertised $37
    //     next to a live buy button. A price the seller did not set is the one
    //     leftover that actively misleads a buyer, so every occurrence must be
    //     labellable.
    //   BOOK_COVER / BOOK_COVER_ALT — the cover is shown in the hero, again in
    //     a mockup or "what you get" block, again beside the buy button. Only
    //     the first could be labelled, and a duplicate label failed the whole
    //     annotation and was retried, so the model dropped the second node to
    //     satisfy the rule. The unlabelled <img> then keeps the template's own
    //     src, and rewriteHtmlAssets DELETES an img whose asset did not rehost
    //     (rather than leave it loading from the copied site) — which is how a
    //     published page ends up with one cover rendered and the other slot
    //     empty. Its best case was no better: the original seller's cover.
    const repeatable =
      entry.placeholder === 'CHECKOUT_URL' ||
      entry.placeholder === 'CTA_TEXT' ||
      entry.placeholder === 'PRICE' ||
      entry.placeholder === 'COMPARE_AT_PRICE' ||
      entry.placeholder === 'BOOK_COVER' ||
      entry.placeholder === 'BOOK_COVER_ALT';
    const isCore = Boolean(CORE_PLACEHOLDERS[entry.placeholder]);
    if (isCore && !repeatable) {
      const already = claimed.get(entry.placeholder);
      if (already && already !== entry.nodeId) {
        errors.push(`${entry.placeholder} was assigned to two different nodes (${already} and ${entry.nodeId}).`);
        continue;
      }
      claimed.set(entry.placeholder, entry.nodeId);
    }

    const originalText = node.text ?? node.alt ?? '';
    placeholders.push({
      tplId: entry.nodeId,
      placeholder: entry.placeholder,
      kind,
      maxChars: budgetFor(entry.maxChars ?? undefined, originalText),
      originalText,
      hadInlineMarkup: node.hasInlineMarkup === true,
      ...(node.rect ? { rect: node.rect } : {}),
    });
  }

  // ── the guard that outranks the model ────────────────────────────────────
  for (const ctaId of page.ctaIds) {
    if (placeholders.some((p) => p.tplId === ctaId && p.placeholder === 'CHECKOUT_URL')) continue;
    const node = byId.get(ctaId);
    placeholders.push({
      tplId: ctaId,
      placeholder: 'CHECKOUT_URL',
      kind: 'href',
      maxChars: 2048,
      originalText: node?.href ?? '',
      hadInlineMarkup: false,
    });
    findings.push({
      severity: 'INFO',
      code: 'CTA_FORCED',
      message: `A buy button (${ctaId}) was not labelled and was assigned the checkout link automatically.`,
    });
  }

  // ── repeaters: detection is mechanical, naming is the model's ────────────
  const named = new Map(annotation.repeaters.map((r) => [r.containerTplId, r.key]));
  const repeaters: RepeaterEntry[] = [];
  for (const detected of page.repeaters) {
    const key = named.get(detected.containerTplId);
    if (!key) continue;
    if (!REPEATER_PLACEHOLDERS[key]) {
      errors.push(`"${key}" is not a known repeating region.`);
      continue;
    }
    if (repeaters.some((r) => r.key === key)) {
      findings.push({
        severity: 'WARN',
        code: 'DUPLICATE_REPEATER',
        message: `More than one container was named ${key}; only the first is used.`,
      });
      continue;
    }
    const fields = placeholders
      .map((p) => splitRepeaterField(p.placeholder))
      .filter((f): f is { key: string; field: string } => f !== null && f.key === key)
      .map((f) => f.field);
    repeaters.push({ ...detected, key, fields: [...new Set(fields)] });
  }

  // A labelled region with no fields would clone an item that has nothing to
  // fill, printing the template's own words once per book.
  for (const repeater of repeaters) {
    if (repeater.fields.length === 0) {
      errors.push(`Repeater "${repeater.key}" was named but none of its item's fields were labelled.`);
    }
  }

  const extended = placeholders.filter((p) => isExtendedKey(p.placeholder)).length;
  if (extended === 0 && page.sections.length > 5) {
    findings.push({
      severity: 'WARN',
      code: 'NO_EXTENDED_SLOTS',
      message:
        `The template has ${page.sections.length} sections but no extended slots were assigned. Sections the core ` +
        "vocabulary does not cover will keep the original page's words.",
    });
  }

  return { placeholders, repeaters, findings, errors };
}

/**
 * The character budget for a slot.
 *
 * Measured from the template's own text, not taken from the model: the CSS was
 * tuned to those words, so their length is the only honest ceiling. The model's
 * suggestion is accepted only when it is close to the measurement.
 */
function budgetFor(suggested: number | undefined, originalText: string): number {
  const measured = Math.max(MIN_MAX_CHARS, Math.ceil(originalText.length * LENGTH_HEADROOM));
  if (!suggested || !Number.isFinite(suggested) || suggested <= 0) return measured;
  // Within a quarter of the measurement, the model's number is fine and may
  // reflect something it can see that a character count cannot. Beyond that,
  // the measurement wins.
  const ratio = suggested / measured;
  return ratio > 0.75 && ratio < 1.25 ? Math.round(suggested) : measured;
}

/**
 * Text that still names the template's owner.
 *
 * Easy to miss and embarrassing when it ships: a footer, a masthead or an alt
 * attribute still reading "The Mechanic Bible" on a page selling something
 * else. Reported rather than auto-removed — the fix is usually to label the
 * node, which is a decision, not a deletion.
 */
function brandLeakFindings(html: string, host: string, title: string): Finding[] {
  const candidates = new Set<string>();

  const bare = host.replace(/^www\./, '').split('.')[0] ?? '';
  if (bare.length >= 5) candidates.add(bare);

  // "The Mechanic Bible — Fix your own car" → "The Mechanic Bible"
  const brandFromTitle = (title.split(/[|—–:·-]/)[0] ?? '').trim();
  if (brandFromTitle.length >= 5 && brandFromTitle.split(/\s+/).length <= 5) candidates.add(brandFromTitle);

  const text = html.replace(/<[^>]+>/g, ' ');
  const findings: Finding[] = [];
  for (const candidate of candidates) {
    const re = new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const hits = text.match(re);
    if (hits && hits.length > 0) {
      findings.push({
        severity: 'WARN',
        code: 'BRAND_LEAK',
        message:
          `"${candidate}" still appears ${hits.length} time(s) in the template text. Label those nodes ` +
          'BRAND_NAME, or the published page will name the template owner.',
      });
    }
  }
  return findings;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function emptyReport(): ExtractionReport {
  return {
    findings: [],
    cleaningLoss: [],
    droppedImages: [],
    fontFidelity: 'none',
    lostFamilies: [],
    assetBytes: 0,
    sectionCount: 0,
    detectedRepeaters: [],
    residualPrices: [],
    notes: [],
  };
}

function blank(id: string, ownerId: string, sourceUrl: string, revision: number): StoredLandingTemplate {
  return {
    id,
    ownerId,
    sourceUrl,
    state: 'FAILED',
    name: null,
    originalHtmlPath: null,
    cleanHtmlPath: null,
    cssBundlePath: null,
    placeholders: [],
    repeaters: [],
    theme: { accentToken: null, accentValue: null, onAccentValue: null, isDark: false, rootTokens: {} },
    typography: { heading: null, body: null, familiesUsed: [] },
    responsive: { widths: [], breakpoints: [], sections: [] },
    baselineShots: [],
    overrides: [],
    report: null,
    failureReason: null,
    pipelineVersion: LANDING_PIPELINE_VERSION,
    revision,
    capturedAt: null,
  };
}
