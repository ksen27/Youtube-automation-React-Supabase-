import type { Locator, Page } from 'playwright';
import { isLoginUrl } from './PayhipBrowser';
import {
  PayhipSessionExpired,
  PayhipTransientError,
  PayhipRejected,
  PayhipProductCreatedButUnreadable,
} from './PayhipErrors';

/**
 * Page object for Payhip's product-creation flow.
 *
 * Every selector in the automation lives HERE and nowhere else. Payhip ships UI
 * changes on their own schedule and without notice, so when the flow breaks the
 * fix is confined to this file — the publisher's retry policy, the session
 * handling and the use case are all untouched by a renamed button.
 *
 * SELECTOR POLICY: role- and label-based locators (`getByRole`, `getByLabel`,
 * `getByPlaceholder`) in preference to CSS or XPath. They survive restyling and
 * class-name churn, which is what actually changes between deploys, and they
 * break loudly rather than silently matching the wrong element. Where a control
 * has no accessible name, a scoped `input[type=...]` is used and the reason is
 * noted at the call site.
 *
 * FALLBACK CHAINS: several steps try more than one accessible name (`Add New
 * Product` / `New product` / `Add product`). Payhip's wording differs between
 * the empty-state dashboard and the populated one, and an operator's first ever
 * run is precisely the empty-state case. `firstVisible` takes whichever exists.
 *
 * NOTE ON VERIFICATION: these names were written against Payhip's dashboard as
 * documented, and are exercised for real only by the `@e2e` test (PAYHIP_E2E=1),
 * which needs a live logged-in account. The unit tests assert flow ORDER and
 * error mapping against a mocked page — they cannot prove a selector matches.
 * If Payhip has moved something, the e2e run is what tells you, and the failure
 * arrives with a screenshot.
 *
 * WAITING: every wait here is `locator.waitFor(...)`, Playwright's own
 * auto-retrying wait — never a sleep, which would be both slower and flakier.
 * The `expect()` web-first assertions ship in `@playwright/test`, a test-runner
 * package this project does not install and which has no business being
 * imported by worker code; `waitFor` is the same auto-waiting machinery without
 * the runner.
 */

/** How long a file upload may take, over and above the per-action timeout. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/** `payhip.com/b/AbC12` → `AbC12`. The store's own id for the product. */
export function extractProductKey(url: string): string | null {
  const match = url.match(/payhip\.com\/b\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

/** The typed fields of the product form. Files are uploaded separately. */
export interface PayhipProductInput {
  title: string;
  description: string;
  /** Major units, formatted for the form (e.g. "19.00"). */
  priceText: string;
}

export class PayhipProductPage {
  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
  ) {}

  /**
   * Open the dashboard and confirm the restored session is still logged in.
   *
   * Throws `PayhipSessionExpired` rather than attempting any login — the worker
   * has no credentials and could not clear a captcha if it did.
   */
  async openDashboard(): Promise<void> {
    await this.page.goto(`${this.baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {
      // A failed navigation is not evidence of an expired session; let the URL
      // and marker checks below decide, and report a transient failure if the
      // page never arrives.
    });
    if (isLoginUrl(this.page.url())) {
      throw new PayhipSessionExpired('the dashboard redirected to the login page');
    }
    // A positive marker, not merely "no login redirect": a blank page or an
    // error page is not a working dashboard, and treating it as one only moves
    // the failure to a more confusing step.
    const addProduct = this.addProductButton();
    const authed = await addProduct
      .waitFor({ state: 'visible' })
      .then(() => true)
      .catch(() => false);
    if (!authed) {
      if (isLoginUrl(this.page.url())) {
        throw new PayhipSessionExpired('the dashboard redirected to the login page');
      }
      throw new PayhipTransientError(
        `the Payhip dashboard did not finish loading (still at ${this.page.url()})`,
      );
    }
  }

  /** Dashboard → Add New Product → Digital Product. */
  async startDigitalProduct(): Promise<void> {
    await this.addProductButton().click();
    // Payhip offers several product kinds (digital, membership, physical,
    // coupon). Picking the wrong one silently produces a product that cannot be
    // downloaded, so this is an explicit click and not a "first option" guess.
    const digital = firstVisible(this.page, [
      this.page.getByRole('link', { name: /digital product/i }),
      this.page.getByRole('button', { name: /digital product/i }),
      this.page.getByText(/^digital product$/i),
    ]);
    await digital.click();
    // The title field is the proof the digital-product form actually opened —
    // without it the next step would type into whatever the click landed on.
    await this.titleField().waitFor({ state: 'visible' });
  }

  async fillDetails(input: PayhipProductInput): Promise<void> {
    await this.titleField().fill(input.title);

    // The description editor is a rich-text widget, not a plain textarea, so
    // `fill` may not reach it. Try the labelled control first and fall back to
    // typing into the editable region.
    const description = firstVisible(this.page, [
      this.page.getByLabel(/description/i),
      this.page.getByRole('textbox', { name: /description/i }),
      this.page.locator('[contenteditable="true"]').first(),
    ]);
    await description.click();
    await description.fill(input.description).catch(async () => {
      // contenteditable regions reject fill(); type into them instead.
      await description.pressSequentially(input.description);
    });

    await this.priceField().fill(input.priceText);
  }

  /**
   * Upload the ebook itself.
   *
   * `setInputFiles` targets the file input directly rather than clicking the
   * styled drop zone: the visible control is usually a label over a hidden
   * input, and driving the input is both faster and immune to the drop zone's
   * restyling. The wait afterwards is on the FILENAME appearing — an upload
   * that has been accepted, not merely started, which for a multi-megabyte PDF
   * are minutes apart.
   */
  async uploadPdf(pdfPath: string, filename: string): Promise<void> {
    const input = this.page.locator('input[type="file"]').first();
    await input.setInputFiles(pdfPath);
    await this.page
      .getByText(filename, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: UPLOAD_TIMEOUT_MS })
      .catch(() => {
        throw new PayhipTransientError(
          `the ebook upload (${filename}) did not complete within ${Math.round(UPLOAD_TIMEOUT_MS / 60_000)} minutes`,
        );
      });
  }

  /**
   * Upload the cover image, if the book has one.
   *
   * Best-effort by design: a listing with no image still sells, and failing the
   * whole run — after the PDF has already uploaded — over a thumbnail would be
   * a poor trade. Returns whether it landed, so the caller can log the truth.
   */
  async uploadCover(coverPath: string): Promise<boolean> {
    try {
      const zone = firstVisible(this.page, [
        this.page.getByLabel(/cover image|product image|thumbnail/i),
        this.page.getByText(/cover image|product image/i),
      ]);
      await zone.scrollIntoViewIfNeeded();
      // The cover input is the second file input on the form (the first is the
      // product file). Scoped by position because these inputs are hidden and
      // carry no accessible name of their own.
      const inputs = this.page.locator('input[type="file"]');
      const count = await inputs.count();
      if (count < 2) return false;
      await inputs.nth(1).setInputFiles(coverPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Publish, then read back the product's public link.
   *
   * The link is the whole point of the run, so it is read from the page rather
   * than composed from the title: Payhip assigns the key, and a guessed URL
   * that 404s would be written into a live sales page's buy button.
   */
  async publishAndReadLink(): Promise<{ productKey: string; buyUrl: string }> {
    const publish = firstVisible(this.page, [
      this.page.getByRole('button', { name: /^(publish|save|create product)$/i }),
      this.page.getByRole('button', { name: /publish|save/i }),
    ]);
    await publish.click();

    // Payhip surfaces validation failures (price rejected, file too large) as
    // inline errors and simply stays on the form. Checked BEFORE waiting for a
    // link, so the operator gets Payhip's own words instead of our timeout.
    const validationError = this.page.locator('.error, [role="alert"]').first();
    const rejected = await validationError
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (rejected) {
      const text = (await validationError.textContent().catch(() => ''))?.trim();
      if (text) throw new PayhipRejected(`Payhip rejected the product: ${text}`);
    }

    const link = await this.readProductLink();
    if (!link) {
      // Past this point the product may well exist — the publish click was
      // accepted and only the read-back failed. Its own error type, because
      // this is the one failure a retry makes strictly worse.
      throw new PayhipProductCreatedButUnreadable(`no payhip.com/b/... link appeared on ${this.page.url()}`);
    }
    return link;
  }

  /**
   * Find the product's `payhip.com/b/XXXX` link, wherever Payhip put it.
   *
   * Three places, in order of how directly they name the product: the success
   * screen's own link element, the page URL itself (some flows redirect to the
   * product), and finally the raw page text. Returns null if none of them yield
   * a key.
   */
  private async readProductLink(): Promise<{ productKey: string; buyUrl: string } | null> {
    const anchor = this.page.locator('a[href*="payhip.com/b/"]').first();
    const href = await anchor
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => anchor.getAttribute('href'))
      .catch(() => null);
    const fromAnchor = href ? extractProductKey(href) : null;
    if (fromAnchor) return { productKey: fromAnchor, buyUrl: `https://payhip.com/b/${fromAnchor}` };

    const fromUrl = extractProductKey(this.page.url());
    if (fromUrl) return { productKey: fromUrl, buyUrl: `https://payhip.com/b/${fromUrl}` };

    const body = await this.page.content().catch(() => '');
    const fromBody = extractProductKey(body);
    if (fromBody) return { productKey: fromBody, buyUrl: `https://payhip.com/b/${fromBody}` };

    return null;
  }

  /**
   * Look for a product we already created for this book.
   *
   * The safety net behind the DB idempotency guard: if a previous run published
   * successfully and then died before the link was persisted, our records show
   * nothing while the store shows a product. Searching for the title before
   * creating turns that into a recovered link instead of a duplicate listing.
   */
  async findExistingByTitle(title: string): Promise<{ productKey: string; buyUrl: string } | null> {
    await this.page.goto(`${this.baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (isLoginUrl(this.page.url())) throw new PayhipSessionExpired();
    const row = this.page.getByText(title, { exact: true }).first();
    const present = await row
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!present) return null;
    return this.readProductLink();
  }

  // ── locators ──────────────────────────────────────────────────────────────
  // Named separately from their uses so the same control is described once.

  private addProductButton(): Locator {
    return firstVisible(this.page, [
      this.page.getByRole('link', { name: /add new product|new product|add product/i }),
      this.page.getByRole('button', { name: /add new product|new product|add product/i }),
    ]);
  }

  private titleField(): Locator {
    return firstVisible(this.page, [
      this.page.getByLabel(/product name|title/i),
      this.page.getByPlaceholder(/product name|title/i),
      this.page.getByRole('textbox', { name: /name|title/i }),
    ]);
  }

  private priceField(): Locator {
    return firstVisible(this.page, [
      this.page.getByLabel(/^price/i),
      this.page.getByPlaceholder(/price|0\.00/i),
      this.page.getByRole('spinbutton', { name: /price/i }),
    ]);
  }
}

/**
 * The first of several candidate locators that actually resolves.
 *
 * Playwright's `.or()` does exactly this and keeps the result a live Locator,
 * so the choice is re-made at click time rather than frozen when the chain was
 * built — which matters on a form that renders progressively.
 */
function firstVisible(_page: Page, candidates: Locator[]): Locator {
  const [head, ...rest] = candidates;
  if (!head) throw new Error('firstVisible called with no candidates');
  return rest.reduce((acc, next) => acc.or(next), head).first();
}
