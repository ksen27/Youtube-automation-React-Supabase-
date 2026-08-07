import puppeteer, { type Browser, type Page } from 'puppeteer';
import {
  Result,
  type CapturedAsset,
  type CapturedTemplate,
  type InventoryNode,
  type ParameteriseInput,
  type RepeaterEntry,
  type SectionGeometry,
  type Shot,
  type TemplateCapturer,
  type ThemeTokens,
  type TypographyTokens,
} from '@ebook/core';
import { assertPublicUrl } from './HttpReferencePageFetcher';
import {
  applyMapScript,
  AUTOSCROLL,
  CLEAN,
  OPEN_DISCLOSURES,
  COLLECT_CSS,
  COLLECT_IMAGE_URLS,
  DETECT_REPEATERS,
  INVENTORY,
  RESTORE_DISCLOSURE,
  MEASURE,
  STAMP,
  UNHIDE_REVEALS,
} from '../landing/browserScripts';

/**
 * Widths every template is captured and verified at. Desktop, tablet, phone —
 * the three the responsive rules actually branch on.
 */
const WIDTHS = [1280, 768, 390] as const;

const NAV_TIMEOUT_MS = 45_000;

/**
 * Screenshot height ceiling. Chromium itself caps around 16,384px, and a raw
 * bitmap at 1280 × 12,000 is already ~46 MB in the differ — six of those in
 * flight is what would take the worker down.
 */
const MAX_SHOT_HEIGHT = 12_000;

/** Per-asset ceiling. A template's hero image is not a video file. */
const MAX_ASSET_BYTES = 4_000_000;
const MAX_TOTAL_ASSET_BYTES = 24_000_000;
const ASSET_TIMEOUT_MS = 10_000;

/** Serving origin for the offline render in `shoot`. Never resolved by DNS. */
const RENDER_ORIGIN = 'https://template.invalid/';

/**
 * Renders a template site in a real browser and returns everything needed to
 * reproduce it.
 *
 * One browser session produces the DOM, the CSS, the measurements and the
 * screenshots, so all four describe the same page. The previous pair of
 * services could not promise that: `HttpReferencePageFetcher` read the server's
 * HTML with no JavaScript while `PuppeteerReferenceScreenshotter` photographed
 * the painted page, and the model was left to reconcile two different
 * documents.
 */
export class PuppeteerTemplateCapturer implements TemplateCapturer {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async capture(url: string): Promise<Result<CapturedTemplate>> {
    // Before the browser starts, not after: navigating IS the dangerous act.
    const safe = await assertPublicUrl(url);
    if (safe.isFail()) return Result.fail(safe.error);

    let browser: Browser | null = null;
    const notes: string[] = [];
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.setUserAgent(
        'Mozilla/5.0 (compatible; EbookGenerator/1.0; +landing-page template capture)',
      );

      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
      const status = response?.status() ?? 0;
      if (status >= 400) return Result.fail(`${url} returned ${status}`);
      const finalUrl = page.url();

      // A bot challenge renders as a real page with a real 200. Naming it is
      // the difference between "extraction failed" and a user who can act.
      const challenge = await this.detectChallenge(page);
      if (challenge) return Result.fail(challenge);

      await page.evaluate(AUTOSCROLL);

      const originalHtml = (await page.evaluate('document.documentElement.outerHTML')) as string;
      const cssCollected = (await page.evaluate(COLLECT_CSS)) as {
        sheets: Array<{ href: string | null; css: string }>;
        opaque: string[];
      };
      const imageUrls = (await page.evaluate(COLLECT_IMAGE_URLS)) as string[];

      // ── the fidelity target, before anything is removed ──
      const baselineShots = await this.shootWidths(page, notes);

      // Open the accordions BEFORE the scripts go, so their content mounts and
      // can be measured. The baseline shots above already recorded the page as
      // a visitor first sees it, with everything closed.
      const opened = (await page.evaluate(OPEN_DISCLOSURES)) as number;
      if (opened > 0) {
        notes.push(`${opened} collapsed row(s) were opened so their content could be captured.`);
      }

      // ── clean ──
      const forced = (await page.evaluate(UNHIDE_REVEALS)) as number;
      if (forced > 0) {
        notes.push(
          `${forced} element(s) were left invisible by a scroll-reveal script and had to be forced visible. ` +
            'Check the cleaned screenshots — this is the most common way a cloned page comes back blank.',
        );
      }
      const removed = (await page.evaluate(CLEAN)) as Record<string, number>;
      const removedSummary = Object.entries(removed)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ');
      if (removedSummary) notes.push(`Removed: ${removedSummary}.`);

      // Cleaning just removed the script that opened the template's accordions.
      // Without this the rows survive and their answers never can be read —
      // the FAQ renders as questions with nothing behind them.
      const disclosure = (await page.evaluate(RESTORE_DISCLOSURE)) as { restored: number; native: boolean };
      if (disclosure.restored > 0) {
        notes.push(
          `${disclosure.restored} collapsed row(s) were converted to native <details> so they still open ` +
            'without the template’s JavaScript.',
        );
      }

      const cleanedShots = await this.shootWidths(page, notes);

      // ── address and measure ──
      await page.setViewport({ width: 1280, height: 900 });
      await page.evaluate('window.scrollTo(0, 0)');
      await new Promise((r) => setTimeout(r, 200));

      await page.evaluate(STAMP);
      const inventory = (await page.evaluate(INVENTORY)) as InventoryNode[];
      const rawRepeaters = (await page.evaluate(DETECT_REPEATERS)) as Array<{
        containerTplId: string;
        itemTplId: string;
        itemCount: number;
        flexibleCount: boolean;
        sampleText: string;
      }>;
      const measured = (await page.evaluate(MEASURE)) as {
        ctaIds: string[];
        ctaCount: number;
        accentValue: string | null;
        onAccentValue: string | null;
        accentToken: string | null;
        isDark: boolean;
        rootTokens: Record<string, string>;
        typography: TypographyTokens;
        sections: Array<Omit<SectionGeometry, 'width'>>;
        contentImages: Array<{ tplId: string; sourceUrl: string; width: number; height: number }>;
        title: string;
      };

      const cleanHtml = (await page.evaluate(
        "'<!doctype html>\\n' + document.documentElement.outerHTML",
      )) as string;

      await browser.close();
      browser = null;

      // ── everything below is plain HTTP, SSRF-guarded ──
      const opaqueCss = await this.fetchOpaqueSheets(cssCollected.opaque, notes);
      const css = cssCollected.sheets.map((s) => s.css).join('\n') + (opaqueCss ? `\n${opaqueCss}` : '');

      const assets = await this.fetchAssets(imageUrls, notes);

      const theme: ThemeTokens = {
        accentToken: measured.accentToken,
        accentValue: measured.accentValue,
        onAccentValue: measured.onAccentValue,
        isDark: measured.isDark,
        rootTokens: measured.rootTokens,
      };

      const repeaters: RepeaterEntry[] = rawRepeaters.map((r) => ({
        // Named by the annotation call; mechanically detected here.
        key: '',
        containerTplId: r.containerTplId,
        itemTplId: r.itemTplId,
        originalCount: r.itemCount,
        flexibleCount: r.flexibleCount,
        fields: [],
      }));

      if (measured.ctaCount === 0) {
        notes.push('No buy button could be identified on this page. Every checkout link must be labelled by hand.');
      }

      return Result.ok({
        sourceUrl: url,
        finalUrl,
        title: measured.title,
        originalHtml,
        cleanHtml,
        css,
        assets,
        inventory,
        repeaters,
        ctaIds: measured.ctaIds,
        theme,
        // Defensive: an older cached MEASURE, or a page whose body never
        // painted, returns no typography rather than a malformed one.
        typography: measured.typography ?? { heading: null, body: null, familiesUsed: [] },
        sections: measured.sections.map((s) => ({ ...s, width: 1280 })),
        baselineShots,
        cleanedShots,
        contentImages: measured.contentImages,
        notes,
      });
    } catch (e) {
      return Result.fail(`Could not capture ${url}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  async parameterise(
    input: ParameteriseInput,
  ): Promise<Result<{ html: string; appliedIds: string[]; droppedIds: string[] }>> {
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      // The document is self-contained and carries no scripts by this point —
      // `setContent` with no network is the whole job.
      await page.setContent(input.cleanHtml, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

      const script = applyMapScript({
        placeholders: input.placeholders.map((p) => ({
          tplId: p.tplId,
          placeholder: p.placeholder,
          kind: p.kind,
        })),
        repeaters: input.repeaters
          .filter((r) => r.key && r.itemTplId)
          .map((r) => ({ key: r.key, containerTplId: r.containerTplId, itemTplId: r.itemTplId })),
        optionalKeys: ['AUTHOR_IMAGE', 'BRAND_LOGO'],
      });

      const out = (await page.evaluate(script)) as {
        html: string;
        appliedIds: string[];
        droppedIds: string[];
      };
      return Result.ok(out);
    } catch (e) {
      return Result.fail(`Could not parameterise the template: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  async shoot(input: {
    html: string;
    assets: Array<{ sitePath: string; bytes: Uint8Array; contentType: string }>;
    widths: number[];
  }): Promise<Result<Shot[]>> {
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage();

      // The page references its assets by relative path, which `setContent`
      // cannot resolve — there is no base URL. Serving both the document and
      // its assets from a fake origin gives relative paths something to resolve
      // against, and every request that is not one of ours is aborted, so the
      // render is provably offline.
      const byPath = new Map(input.assets.map((a) => [a.sitePath.replace(/^\.?\//, ''), a]));
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const requested = request.url();
        if (requested === RENDER_ORIGIN || requested === `${RENDER_ORIGIN}index.html`) {
          void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: input.html });
          return;
        }
        if (requested.startsWith(RENDER_ORIGIN)) {
          const path = decodeURIComponent(requested.slice(RENDER_ORIGIN.length).split('?')[0] ?? '');
          const asset = byPath.get(path);
          if (asset) {
            void request.respond({
              status: 200,
              contentType: asset.contentType,
              body: Buffer.from(asset.bytes),
            });
            return;
          }
        }
        void request.abort();
      });

      await page.goto(RENDER_ORIGIN, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
      await page.evaluate('document.fonts ? document.fonts.ready : Promise.resolve()').catch(() => undefined);

      const shots: Shot[] = [];
      for (const width of input.widths) {
        await page.setViewport({ width, height: 900 });
        await new Promise((r) => setTimeout(r, 250));
        shots.push(await this.shootOne(page, width));
      }
      return Result.ok(shots);
    } catch (e) {
      return Result.fail(`Could not render the page: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async shootWidths(page: Page, notes: string[]): Promise<Shot[]> {
    const shots: Shot[] = [];
    for (const width of WIDTHS) {
      await page.setViewport({ width, height: 900 });
      await page.evaluate('window.scrollTo(0, 0)');
      await new Promise((r) => setTimeout(r, 350));
      const shot = await this.shootOne(page, width, notes);
      shots.push(shot);
    }
    await page.setViewport({ width: 1280, height: 900 });
    return shots;
  }

  private async shootOne(page: Page, width: number, notes?: string[]): Promise<Shot> {
    const height = (await page.evaluate('document.documentElement.scrollHeight')) as number;
    const clipped = height > MAX_SHOT_HEIGHT;
    if (clipped && notes && !notes.some((n) => n.startsWith('The page is taller'))) {
      notes.push(
        `The page is taller than ${MAX_SHOT_HEIGHT}px (${height}px); screenshots cover the top ` +
          `${MAX_SHOT_HEIGHT}px. The clone itself is complete — only the visual check is.`,
      );
    }
    const buffer = clipped
      ? await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height: MAX_SHOT_HEIGHT } })
      : await page.screenshot({ type: 'png', fullPage: true });
    return { width, mediaType: 'image/png', dataBase64: Buffer.from(buffer).toString('base64') };
  }

  /**
   * A challenge page is a 200 with a real DOM, so nothing upstream catches it.
   * Naming the protection is what lets the user do something about it.
   */
  private async detectChallenge(page: Page): Promise<string | null> {
    const probe = (await page.evaluate(
      `(function () {
        const title = (document.title || '').toLowerCase();
        const text = (document.body ? document.body.innerText : '').slice(0, 400).toLowerCase();
        return { title: title, text: text, blocks: document.querySelectorAll('section, header, footer, main').length };
      })()`,
    )) as { title: string; text: string; blocks: number };

    const signatures: Array<[RegExp, string]> = [
      [/just a moment|checking your browser|cf-browser-verification|cloudflare/i, 'Cloudflare'],
      [/attention required|access denied|forbidden/i, 'a WAF'],
      [/datadome|please enable javascript and cookies/i, 'DataDome'],
      [/are you a robot|captcha|hcaptcha|recaptcha/i, 'a CAPTCHA'],
    ];
    const haystack = `${probe.title} ${probe.text}`;
    for (const [pattern, name] of signatures) {
      if (pattern.test(haystack)) {
        return (
          `${name} served a challenge page instead of the template ("${probe.title.slice(0, 60)}"). ` +
          'Bot protection has to be lifted for this worker, or the page HTML supplied by hand.'
        );
      }
    }
    if (probe.blocks < 2 && probe.text.trim().length < 200) {
      return (
        'The page rendered almost nothing — this is usually a single-page app whose content lives behind a ' +
        'route, or a build that never hydrated. Point at the rendered landing URL instead.'
      );
    }
    return null;
  }

  /** Cross-origin stylesheets, which the browser will not read for us. */
  private async fetchOpaqueSheets(hrefs: string[], notes: string[]): Promise<string> {
    if (hrefs.length === 0) return '';
    const out: string[] = [];
    let failed = 0;
    for (const href of hrefs.slice(0, 12)) {
      const safe = await assertPublicUrl(href);
      if (safe.isFail()) {
        failed++;
        continue;
      }
      try {
        const res = await this.fetchImpl(href, {
          redirect: 'follow',
          signal: AbortSignal.timeout(ASSET_TIMEOUT_MS),
          headers: { 'User-Agent': 'EbookGenerator/1.0 (+landing-page template capture)', Accept: 'text/css' },
        });
        if (!res.ok) {
          failed++;
          continue;
        }
        out.push(await res.text());
      } catch {
        failed++;
      }
    }
    if (failed > 0) {
      notes.push(
        `${failed} cross-origin stylesheet(s) could not be read. Anything they styled will fall back to the ` +
          'template’s remaining CSS.',
      );
    }
    return out.join('\n');
  }

  private async fetchAssets(urls: string[], notes: string[]): Promise<CapturedAsset[]> {
    const assets: CapturedAsset[] = [];
    let total = 0;
    let skipped = 0;

    for (const url of urls) {
      if (total >= MAX_TOTAL_ASSET_BYTES) {
        skipped++;
        continue;
      }
      const safe = await assertPublicUrl(url);
      if (safe.isFail()) {
        skipped++;
        continue;
      }
      try {
        const res = await this.fetchImpl(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(ASSET_TIMEOUT_MS),
          headers: { 'User-Agent': 'EbookGenerator/1.0 (+landing-page template capture)' },
        });
        if (!res.ok) {
          skipped++;
          continue;
        }
        const buffer = new Uint8Array(await res.arrayBuffer());
        if (buffer.byteLength > MAX_ASSET_BYTES) {
          skipped++;
          continue;
        }
        total += buffer.byteLength;
        assets.push({
          sourceUrl: url,
          kind: 'image',
          bytes: buffer,
          contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        });
      } catch {
        skipped++;
      }
    }
    if (skipped > 0) notes.push(`${skipped} asset(s) could not be re-hosted and will not appear on the page.`);
    return assets;
  }
}
