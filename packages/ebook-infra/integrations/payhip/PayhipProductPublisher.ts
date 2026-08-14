import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  Result,
  type CheckoutProductPublisher,
  type CheckoutProductDraft,
  type CheckoutProductFile,
  type PublishedCheckoutProduct,
  type CheckoutPublishError,
  type Logger,
} from '@ebook/core';
import { openPayhipContext, withDiagnostics, type PayhipBrowserConfig } from './PayhipBrowser';
import { PayhipProductPage } from './PayhipProductPage';
import { PayhipSessionStore } from './PayhipSessionStore';
import {
  PayhipError,
  PayhipNotConfigured,
  PayhipRejected,
  PayhipSessionExpired,
  PayhipTransientError,
} from './PayhipErrors';

/**
 * Creates Payhip products by driving the real dashboard in a headless browser.
 *
 * Payhip publishes no API for product creation — their public API covers
 * coupons and license keys only — so this is browser automation by necessity
 * rather than by preference. Everything above the `CheckoutProductPublisher`
 * port is insulated from that fact.
 *
 * This class owns POLICY: how many attempts, what is worth retrying, when to
 * flag the session dead, what the operator is told. The dashboard's shape lives
 * in `PayhipProductPage`; launching and diagnostics live in `PayhipBrowser`.
 */

/**
 * Whole-flow attempts, and how long to wait before each.
 *
 * The array length IS the attempt count, so the two cannot drift apart. Index 0
 * is the first attempt and waits nothing; a single retry follows fifteen
 * seconds later — long enough for a slow dashboard to settle, short enough that
 * an operator watching the button does not assume it hung.
 */
const DEFAULT_BACKOFF_MS = [0, 15_000];

export interface PayhipPublisherConfig extends PayhipBrowserConfig {
  /** Where uploads are staged. Files are written, uploaded, then deleted. */
  tmpDir?: string | undefined;
  /**
   * Overrides the retry schedule. Exists so tests can exercise the retry path
   * without a fifteen-second wait — fake timers cannot help here, because the
   * flow interleaves real filesystem work with the delay.
   */
  backoffMs?: number[] | undefined;
}

export class PayhipProductPublisher implements CheckoutProductPublisher {
  private configuredCache: boolean | null = null;

  constructor(
    private readonly sessions: PayhipSessionStore,
    private readonly config: PayhipPublisherConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Synchronous by the port's contract, but the answer lives in the database.
   *
   * Resolved by `warmUp()` at container build time and cached; an unwarmed
   * publisher reports true so the attempt proceeds and fails with the precise
   * `PayhipNotConfigured` message instead of a silent "button is missing".
   */
  isConfigured(): boolean {
    return this.configuredCache ?? true;
  }

  /** Refresh the cached answer. Called on boot and after a session is stored. */
  async warmUp(): Promise<boolean> {
    this.configuredCache = await this.sessions.isConfigured().catch(() => false);
    return this.configuredCache;
  }

  async createProduct(
    draft: CheckoutProductDraft,
  ): Promise<Result<PublishedCheckoutProduct, CheckoutPublishError>> {
    let lastError: PayhipError | null = null;
    const backoff = this.config.backoffMs ?? DEFAULT_BACKOFF_MS;

    for (let attempt = 1; attempt <= backoff.length; attempt++) {
      if (attempt > 1) {
        const wait = backoff[attempt - 1] ?? 0;
        this.logger.warn('retrying the Payhip product creation', {
          externalId: draft.externalId,
          attempt,
          waitMs: wait,
          previous: lastError?.message,
        });
        await delay(wait);
      }
      try {
        const product = await this.runFlow(draft, attempt);
        return Result.ok(product);
      } catch (err) {
        const payhipError = asPayhipError(err);
        lastError = payhipError;

        if (payhipError instanceof PayhipSessionExpired) {
          // Flagged so the UI stops offering the button and names the fix,
          // rather than letting every subsequent click fail the same way.
          await this.sessions.markNeedsReauth(payhipError.message).catch(() => {});
          this.configuredCache = false;
        }
        if (!isWorthRetrying(payhipError)) break;
      }
    }

    return Result.fail<PublishedCheckoutProduct, CheckoutPublishError>(toPublishError(lastError));
  }

  /** One full attempt: session → dashboard → form → upload → publish → link. */
  private async runFlow(draft: CheckoutProductDraft, attempt: number): Promise<PublishedCheckoutProduct> {
    const session = await this.sessions.load();
    if (!session?.storageState) throw new PayhipNotConfigured();
    if (session.needsReauth) {
      throw new PayhipSessionExpired(session.note ?? 'the stored session is flagged for re-connect');
    }

    const staged = await this.stageFiles(draft);
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    // Label ties a run's screenshot and HTML snapshot together, and to this log
    // line — without the attempt number a retry overwrites the first failure's
    // evidence, which is usually the more informative of the two.
    const label = `${draft.externalId}_attempt${attempt}`;

    try {
      ({ browser, context } = await openPayhipContext(this.config, session.storageState));
      page = await context.newPage();
      const dashboard = new PayhipProductPage(page, this.config.baseUrl);

      await dashboard.openDashboard();

      // Recovery, not routine: our DB says no product exists, but a previous
      // run may have published and died before persisting. Checked here, where
      // we already have a logged-in dashboard, and only ever COSTS a listing
      // lookup — while the duplicate it prevents costs the seller a real
      // product on their storefront.
      const existing = await dashboard.findExistingByTitle(draft.title).catch(() => null);
      if (existing) {
        this.logger.warn('a Payhip product with this title already exists — adopting it', {
          externalId: draft.externalId,
          productKey: existing.productKey,
        });
        await this.sessions.refresh(await context.storageState()).catch(() => {});
        return { ...existing, createdAt: new Date() };
      }

      await dashboard.startDigitalProduct();
      await dashboard.fillDetails({
        title: draft.title,
        description: draft.description,
        priceText: formatPrice(draft.priceCents),
      });
      await dashboard.uploadPdf(staged.pdfPath, draft.pdf.filename);
      if (staged.coverPath) {
        const ok = await dashboard.uploadCover(staged.coverPath);
        if (!ok) {
          this.logger.warn('cover image could not be attached — listing the product without one', {
            externalId: draft.externalId,
          });
        }
      }

      const link = await dashboard.publishAndReadLink();

      // Re-save the now-fresh cookies so Payhip's sliding session window resets.
      // Without this the session lapses between listings and the operator is
      // sent back to the connect command far sooner than they need to be.
      await this.sessions.refresh(await context.storageState()).catch(() => {});

      return { productKey: link.productKey, buyUrl: link.buyUrl, createdAt: new Date() };
    } catch (err) {
      const payhipError = asPayhipError(err);
      // Diagnostics captured while the page is still open — after the finally
      // block closes the browser there is nothing left to photograph.
      throw await withDiagnostics(payhipError, page, this.config.debugDir, label);
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      await staged.cleanup();
    }
  }

  /**
   * Write the upload bytes to real files.
   *
   * Playwright's `setInputFiles` needs a path on disk, and the book lives in
   * object storage — so the bytes make a round trip through a temp directory.
   * Removed in `finally` whether the run succeeded or not: these are complete
   * copies of a saleable product, and leaving them on a shared worker disk is
   * both a leak and, over enough runs, a full volume.
   */
  private async stageFiles(draft: CheckoutProductDraft): Promise<{
    pdfPath: string;
    coverPath?: string | undefined;
    cleanup: () => Promise<void>;
  }> {
    const base = await fs.mkdtemp(path.join(this.config.tmpDir ?? os.tmpdir(), 'payhip-'));
    const write = async (file: CheckoutProductFile): Promise<string> => {
      const target = path.join(base, file.filename);
      await fs.writeFile(target, file.bytes);
      return target;
    };
    const pdfPath = await write(draft.pdf);
    const coverPath = draft.cover ? await write(draft.cover) : undefined;
    return {
      pdfPath,
      coverPath,
      cleanup: () => fs.rm(base, { recursive: true, force: true }).catch(() => {}),
    };
  }
}

/**
 * Whether another attempt could plausibly do better.
 *
 * A timeout or a navigation failure, yes. An expired session, no — nothing
 * about the second attempt is more logged in than the first. A rejection, no —
 * Payhip will reject identically. And a product that was CREATED but whose link
 * we could not read, emphatically no: retrying that lists the book twice, which
 * is the failure mode this whole guard exists to prevent.
 */
function isWorthRetrying(error: PayhipError): boolean {
  return error instanceof PayhipTransientError;
}

/** Map an adapter error onto the provider-agnostic shape the core understands. */
function toPublishError(error: PayhipError | null): CheckoutPublishError {
  if (!error) return { kind: 'transient', message: 'Payhip product creation failed for an unknown reason' };
  const kind: CheckoutPublishError['kind'] =
    error instanceof PayhipSessionExpired
      ? 'session-expired'
      : error instanceof PayhipNotConfigured
        ? 'not-configured'
        : error instanceof PayhipTransientError
          ? 'transient'
          : // A rejection and an unreadable-but-created product are both terminal:
            // neither should be retried, and both need a human to look.
            'rejected';
  return { kind, message: error.message, debugPaths: error.debugPaths };
}

/** Anything thrown inside the flow, normalised to a PayhipError. */
function asPayhipError(err: unknown): PayhipError {
  if (err instanceof PayhipError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // Playwright reports timeouts and navigation failures as plain TimeoutError /
  // Error, and those are exactly the class worth retrying.
  if (/timeout|net::|navigation|ERR_/i.test(message)) return new PayhipTransientError(message);
  return new PayhipRejected(message);
}

/** Cents → the major-unit string Payhip's price field expects ("1900" → "19.00"). */
function formatPrice(cents: number): string {
  return (cents / 100).toFixed(2);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
