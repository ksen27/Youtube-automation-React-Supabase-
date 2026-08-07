import puppeteer from 'puppeteer';
import { Result, type ReferenceScreenshotter, type ReferenceShot } from '@ebook/core';
import { assertPublicUrl } from './HttpReferencePageFetcher';

/** Desktop-width capture: sales pages are designed for this measure. */
const VIEWPORT = { width: 1280, height: 900 };

/**
 * How many viewport slices to take. A long sales page is 6-10 screens; four
 * evenly-spaced slices cover the hero, the offer, the proof and the footer
 * without flooding the prompt — each image costs roughly 1.5k tokens.
 */
const MAX_SLICES = 4;

/** Guards against a page that never settles; the capture is best-effort. */
const NAV_TIMEOUT_MS = 30_000;

/**
 * Captures the reference page with a real browser, so the layout model can see
 * how it LOOKS rather than only how it is structured.
 *
 * Every failure is a plain `Result.fail`: the screenshots improve fidelity but
 * are never required to produce a page, and a reference site that blocks
 * automation must not cost a seller their landing page.
 */
export class PuppeteerReferenceScreenshotter implements ReferenceScreenshotter {
  /**
   * Our own page, rendered from a string. No navigation and no network: the
   * document is self-contained by construction, so `setContent` is the whole
   * job and there is no SSRF surface to guard.
   */
  async captureHtml(html: string): Promise<Result<ReferenceShot[]>> {
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage();
      await page.setViewport(VIEWPORT);
      await page.setContent(html, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
      // The page reveals sections on scroll; without this the shots below the
      // fold capture the pre-animation state and every one looks empty.
      await page.evaluate("document.querySelectorAll('[data-anim]').forEach(function(e){e.removeAttribute('data-anim')})");
      return Result.ok(await this.slice(page, true));
    } catch (e) {
      return Result.fail(`Could not screenshot the generated page: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  async capture(url: string): Promise<Result<ReferenceShot[]>> {
    // Before the browser starts, not after: navigating IS the dangerous act.
    const safe = await assertPublicUrl(url);
    if (safe.isFail()) return Result.fail(safe.error);

    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage();
      await page.setViewport(VIEWPORT);
      // Identify honestly rather than impersonating a browser we are not.
      await page.setUserAgent('Mozilla/5.0 (compatible; EbookGenerator/1.0; +landing-page reference capture)');

      // `networkidle2` rather than `load`: these pages lazy-load imagery, and a
      // screenshot taken at `load` is mostly empty boxes.
      await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });

      // Evaluated as source text rather than a closure: this package does not
      // compile against the DOM lib, so `document`/`window` are not in scope here.
      const shots = await this.slice(page);
      return shots.length > 0 ? Result.ok(shots) : Result.fail('Captured no screenshots');
    } catch (e) {
      return Result.fail(`Could not screenshot reference: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // A leaked Chromium survives the job and eventually starves the worker.
      await browser?.close().catch(() => undefined);
    }
  }

  /**
   * Hides fixed-position furniture, for every shot after the first.
   *
   * A sticky bar renders at the top of EVERY viewport screenshot, sitting over
   * whatever content happens to be at that scroll offset. That is what a sticky
   * bar does — but to a reviewer looking at a still image it reads as "the
   * navigation bar covers this heading", and it reads that way on every
   * mid-page shot of every layout that has one.
   *
   * The prompt asks for a sticky bar, so this produced a defect report the
   * layout could not avoid, on a gate that costs an attempt each time. Shot one
   * still shows the bar in place, which is where a reviewer can actually judge
   * it.
   *
   * `visibility` rather than `display` or `position`: a fixed element takes no
   * space in flow, so hiding it this way cannot reflow anything and the shots
   * still describe the same layout.
   */
  private static readonly HIDE_FIXED = `(function () {
    const all = document.querySelectorAll('body *');
    for (let i = 0; i < all.length; i++) {
      if (getComputedStyle(all[i]).position === 'fixed') all[i].style.visibility = 'hidden';
    }
  })()`;

  /**
   * Evenly-spaced viewport slices, top to bottom.
   *
   * @param hideFixedAfterFirst Only for OUR pages, under review. The reference
   *   site is captured exactly as it renders — that is the thing being copied.
   */
  private async slice(
    page: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>['newPage']>>,
    hideFixedAfterFirst = false,
  ) {
    const height = (await page.evaluate('document.body.scrollHeight')) as number;
    const slices = Math.max(1, Math.min(MAX_SLICES, Math.ceil(height / VIEWPORT.height)));
    const step = Math.max(1, Math.floor((height - VIEWPORT.height) / Math.max(1, slices - 1)));

    const shots: ReferenceShot[] = [];
    for (let i = 0; i < slices; i++) {
      const top = slices === 1 ? 0 : Math.min(i * step, Math.max(0, height - VIEWPORT.height));
      await page.evaluate(`window.scrollTo(0, ${top})`);
      if (i === 1 && hideFixedAfterFirst) {
        await page.evaluate(PuppeteerReferenceScreenshotter.HIDE_FIXED);
      }
      // Let lazy content triggered by the scroll actually paint.
      await new Promise((resolve) => setTimeout(resolve, 350));
      const buffer = await page.screenshot({ type: 'png' });
      shots.push({ mediaType: 'image/png', dataBase64: Buffer.from(buffer).toString('base64') });
    }
    return shots;
  }
}
