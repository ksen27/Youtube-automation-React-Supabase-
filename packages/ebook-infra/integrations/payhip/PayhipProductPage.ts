import type { Locator, Page } from 'playwright';
import { isLoginUrl } from './PayhipBrowser';
import {
  PayhipSessionExpired,
  PayhipTransientError,
  PayhipRejected,
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

/**
 * How long a file upload may take, over and above the per-action timeout.
 *
 * Ten minutes is generous on a direct connection and can be far too little
 * through a residential proxy: those are optimised for looking like a home
 * user, not for throughput, and one measured here took 26 seconds to fetch a
 * 14-byte response. A book is several megabytes, so the same link can need half
 * an hour — and timing out mid-upload wastes every minute already spent.
 *
 * Env-overridable because the right value depends entirely on the exit in use,
 * which is an operational choice rather than something this file can know.
 */
const UPLOAD_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.PAYHIP_UPLOAD_TIMEOUT_MS ?? 30 * 60_000),
);

/**
 * Payhip's real routes, read off a live dashboard.
 *
 * NAVIGATING BEATS CLICKING here, and the first version of this file got it
 * wrong. It assumed an "Add New Product" button on the dashboard and hunted for
 * it by accessible name; the actual dashboard is a welcome panel and a nav bar,
 * with no such button anywhere on it. The run failed at the first step with a
 * timeout that blamed the dashboard for loading slowly.
 *
 * These paths are a far more stable contract than button labels: Payhip
 * restyles and rewords, but `/product/add/digital` is the address of a thing.
 * Each is still verified by a marker on arrival, so a moved route fails loudly
 * rather than silently filling in the wrong form.
 */
/**
 * The product form's real controls, read off a live `/product/add/digital`.
 *
 * FORM FIELDS ARE MATCHED BY `name`, NOT BY LABEL — a deliberate exception to
 * this file's role/label-first policy, and the previous version's price locator
 * is why. `getByLabel(/^price/i)` matched `pwyw_suggested_price`, the
 * pay-what-you-want suggested amount, which sits hidden on the page unless that
 * pricing mode is selected. Playwright dutifully waited 45 seconds for a field
 * that is never going to be visible. The form has several plausible "price"
 * fields — global price, sale price, per-variant price, PWYW suggestion — and
 * an accessible-name regex cannot reliably tell them apart, whereas `p_price`
 * is the exact field Payhip's own backend reads.
 *
 * The upload zones are scoped by their CONTAINER id for the same reason: the
 * page carries seven file inputs (product file, product image, preview teaser,
 * and four editor image pickers), all with generated plupload ids, so "the
 * first file input" is a coin flip that silently uploads the ebook into the
 * rich-text editor.
 */
const SELECTORS = {
  title: 'input[name="p_name"]',
  /**
   * The global price. The per-variant field shares the id `p_price` but carries
   * no `name`, so matching on name picks the real one unambiguously.
   */
  price: 'input[name="p_price"]',
  /** Hidden, and the store account's setting — see `readCurrency`. */
  currency: 'input[name="p_currency"]',
  /** Where the description editor syncs its HTML; used to confirm it took. */
  descriptionSync: 'input[name="p_desc"]',
  /** The ebook itself — what the buyer downloads. */
  productFileZone: '#ebook_files',
  /** Cover art for the listing. */
  productImageZone: '#upload_product_images_box',
  /** A free teaser. We never touch it, but it owns a file input we must avoid. */
  previewZone: '#ebook_preview',
  /**
   * One uploaded file, as rendered in the list. The row appears when the upload
   * STARTS; the badge is what marks it finished, which for a 46 MB PDF are
   * minutes apart.
   */
  uploadedFileRow: '.js-upload-digital-file-row',
  uploadedFileBadge: '.js-digital-file-uploaded-badge',
  /**
   * The form's real submit control — an `<input type="submit" value="Add
   * Product">`, not a `<button>`.
   *
   * The obvious `button` selectors are all traps here. The page carries six
   * other submit buttons, every one of them inside the rich-text editor's image
   * modals ("Save", "Edit Image", "Add selected files"), and `js-save-button`
   * — which looks like exactly the right hook — is two of those modal buttons
   * and never the product form. Clicking one submits an invisible dialog while
   * leaving the product uncreated, which looks indistinguishable from success
   * until the link read-back fails.
   */
  submit: '#addsubmit',
} as const;

const ROUTES = {
  dashboard: '/dashboard',
  /** The product list — where an already-created product can be found. */
  products: '/products',
  /** Straight to the digital product form. Sibling of `/product/add/physical`. */
  addDigital: '/product/add/digital',
  /** The product-type chooser, used as a fallback if the direct route moves. */
  create: '/product/create',
} as const;

/**
 * The one signal that a page is logged in: the nav's Products link.
 *
 * Exported because TWO places need it — the automation, deciding whether a
 * restored session still works, and the connect CLI, deciding whether a human
 * has finished logging in. They had their own copies, and the copies drifted:
 * when the dashboard marker was corrected here, the connect flow was left
 * waiting for an "Add New Product" button that does not exist on this
 * dashboard, so a perfectly good login sat there until the ten-minute timeout
 * and saved nothing.
 *
 * Matched on href rather than text: the link is an icon plus a `<span>`, so its
 * accessible name depends on how the icon is labelled, while the href is the
 * destination itself and cannot drift without the route changing.
 */
export const LOGGED_IN_MARKER = 'a[href="/products"]';

/** `payhip.com/b/AbC12` → `AbC12`. The store's own id for the product. */
export function extractProductKey(url: string): string | null {
  const match = url.match(/payhip\.com\/b\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

/**
 * `/product/edit/AbC12` → `AbC12`.
 *
 * The product list links each row to its editor, and that path carries the same
 * key the public buy link uses — which makes the list a second, independent way
 * to recover a link the success page did not show us.
 */
export function extractEditKey(href: string): string | null {
  const match = href.match(/\/product\/edit\/([A-Za-z0-9_-]+)/);
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
    await this.page.goto(`${this.baseUrl}${ROUTES.dashboard}`, { waitUntil: 'domcontentloaded' }).catch(() => {
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
    //
    // The marker is the nav's Products link, because the nav is the one thing
    // present on EVERY logged-in page regardless of account state. The dashboard
    // body is not: a new store shows a "Welcome to Payhip!" setup panel, an
    // established one shows stats, and keying off anything in there means the
    // automation works for one of them and not the other.
    const authed = await this.navProducts()
      .waitFor({ state: 'visible' })
      .then(() => true)
      .catch(() => false);
    if (!authed) {
      if (isLoginUrl(this.page.url())) {
        throw new PayhipSessionExpired('the dashboard redirected to the login page');
      }
      // Say WHAT the page was, not just that it wasn't the dashboard.
      //
      // On a worker the screenshot is written to a container filesystem that
      // does not survive a restart, so in practice the log line IS the
      // evidence. "The dashboard did not finish loading" is true of a slow
      // render, a bot challenge, and an error page alike — and those need
      // completely different fixes. The title and first words of the body
      // separate them at a glance: a Cloudflare interstitial announces itself,
      // and so does a Payhip error page.
      throw new PayhipTransientError(
        `the Payhip dashboard did not finish loading (url=${this.page.url()}, ` +
          `title=${JSON.stringify(await this.pageTitle())}, ` +
          `text=${JSON.stringify(await this.pageSnippet())})`,
      );
    }
  }

  /**
   * Whatever the form is complaining about, in Payhip's own words.
   *
   * Several selectors because a form's error styling is the least standardised
   * thing on it: Bootstrap's `.help-block`/`.has-error`, the newer
   * `.invalid-feedback`, a bare `.error`, and ARIA's `[role="alert"]` are all in
   * play, and Payhip's own `js-` classes may use none of them. Visible text
   * only — these pages carry hidden error templates for every field, and
   * reporting one of those as the reason would be worse than reporting nothing.
   *
   * Returns null when the form is not complaining, which is the normal path.
   */
  private async readValidationErrors(): Promise<string | null> {
    const candidates = [
      '.error:visible',
      '[role="alert"]:visible',
      '.invalid-feedback:visible',
      '.help-block:visible',
      '.has-error:visible',
      '.alert-danger:visible',
      '.text-danger:visible',
      '.form-error:visible',
    ].join(', ');

    // A short settle: the message is usually rendered by the same handler that
    // blocked the submit, so it lands a moment after the click.
    await this.page
      .locator(candidates)
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 })
      .catch(() => {});

    const messages = await this.page
      .locator(candidates)
      .allInnerTexts()
      .catch(() => [] as string[]);

    const cleaned = [...new Set(messages.map((m) => m.replace(/\s+/g, ' ').trim()).filter(Boolean))];
    return cleaned.length > 0 ? cleaned.join(' | ').slice(0, 400) : null;
  }

  private async pageTitle(): Promise<string> {
    return (await this.page.title().catch(() => '')) || '(no title)';
  }

  /** The first line or so of visible text — enough to recognise a challenge page. */
  private async pageSnippet(): Promise<string> {
    const text = await this.page
      .locator('body')
      .innerText({ timeout: 5_000 })
      .catch(() => '');
    return text.replace(/\s+/g, ' ').trim().slice(0, 300) || '(no visible text)';
  }

  /**
   * Open the digital-product form.
   *
   * Goes straight to the route rather than clicking through the dashboard.
   * Payhip offers several product kinds (digital, physical, membership, course,
   * bundle) and picking the wrong one silently produces a product nobody can
   * download — so the type is named in the URL, not inferred from which tile a
   * click landed on.
   *
   * Falls back to the `/product/create` chooser if the direct route ever moves,
   * and only then hunts for a "Digital" option by name.
   */
  async startDigitalProduct(): Promise<void> {
    await this.page.goto(`${this.baseUrl}${ROUTES.addDigital}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (isLoginUrl(this.page.url())) throw new PayhipSessionExpired();

    // The title field is the proof the form actually opened — without it the
    // next step would type into whatever happened to be on screen.
    const opened = await this.titleField()
      .waitFor({ state: 'visible' })
      .then(() => true)
      .catch(() => false);
    if (opened) return;

    await this.page.goto(`${this.baseUrl}${ROUTES.create}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const digital = firstVisible(this.page, [
      this.page.getByRole('link', { name: /digital/i }),
      this.page.getByRole('button', { name: /digital/i }),
      this.page.getByText(/digital (product|download)/i),
    ]);
    await digital.click().catch(() => {
      throw new PayhipTransientError(
        `could not open the digital product form — neither ${ROUTES.addDigital} nor the ` +
          `${ROUTES.create} chooser offered one (at ${this.page.url()})`,
      );
    });
    await this.titleField()
      .waitFor({ state: 'visible' })
      .catch(() => {
        throw new PayhipTransientError(
          `the digital product form did not open (at ${this.page.url()})`,
        );
      });
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

    // The price field carries a default ("5.00"), so this must REPLACE rather
    // than append — `fill` does, but it is worth being explicit about why the
    // field is never empty when we arrive.
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
  async uploadPdf(pdfPath: string, filename: string, onNote: (note: string) => void = () => {}): Promise<void> {
    // WAIT FOR PAYHIP'S UPLOADER TO WIRE ITSELF UP FIRST.
    //
    // The file input is not a plain control — it is created and adopted by
    // plupload/moxie, asynchronously, after the form's HTML has arrived. Setting
    // files on it before that happens does nothing at all: the input holds the
    // file, no change handler is listening, and the page goes on saying "No
    // product files added yet" until the timeout.
    //
    // This never showed up locally because the debug run is headed with a
    // 400ms slow-mo, which gave the shim all the time it needed. On the worker
    // the form opened and the file was set within the same second, and the
    // upload silently never began — a race that only exists at machine speed.
    //
    // The moxie shim's own container is the readiness signal: it exists only
    // once the uploader has initialised, and the input inside it is the one
    // actually being listened to. `attached` rather than `visible` because
    // these inputs are deliberately invisible (opacity 0, behind the button).
    const shimInput = this.page.locator(`${SELECTORS.productFileZone} .moxie-shim input[type="file"]`).first();
    await shimInput.waitFor({ state: 'attached', timeout: 60_000 }).catch(() => {});

    // CLICK THE BUTTON AND ANSWER THE FILE DIALOG, rather than writing to a
    // hidden input.
    //
    // Setting `input.files` directly is the obvious approach and it does not
    // work here, on any of the inputs in this zone — plupload's, the templates',
    // or the first one in document order. All three accept the file and none of
    // them start an upload, because plupload does not simply listen for a
    // `change` event on an input it left lying around; it drives its own
    // runtime from the click.
    //
    // So this does what a person does: click the visible "Upload product file"
    // button, let Payhip open the native file dialog, and answer it. Playwright
    // intercepts that dialog as a `filechooser` event, which means the whole
    // path from click to upload is Payhip's own code — nothing here depends on
    // guessing which element is secretly wired to what.
    const uploadButton = firstVisible(this.page, [
      this.page.locator(SELECTORS.productFileZone).getByText(/upload (another )?product file/i),
      this.page.getByRole('button', { name: /upload (another )?product file/i }),
      this.page.getByText(/upload product file/i),
    ]);

    const viaDialog = await Promise.all([
      this.page.waitForEvent('filechooser', { timeout: 30_000 }),
      uploadButton.click({ timeout: 30_000 }),
    ])
      .then(async ([chooser]) => {
        await chooser.setFiles(pdfPath);
        return true;
      })
      .catch(() => false);

    if (!viaDialog) {
      // The dialog never opened — fall back to the old approach so a Payhip
      // redesign degrades to the previous behaviour rather than refusing to try.
      onNote('the upload button opened no file dialog — falling back to setting the input directly');
      await shimInput.setInputFiles(pdfPath).catch(async () => {
        await this.page
          .locator(`${SELECTORS.productFileZone} input[type="file"]`)
          .first()
          .setInputFiles(pdfPath);
      });
    } else {
      onNote('answered Payhip\'s own file dialog');
    }

    // FIRST: did the upload even START?
    //
    // Payhip renders a row for the file the moment it is accepted, before any
    // bytes have moved. Waiting only for the "uploaded" badge conflated two
    // very different failures — a slow transfer, and one that never began — and
    // spent the full upload budget on both. A worker sat for ten minutes on a
    // form that said "No product files added yet" the entire time, and the
    // error blamed the file's size.
    //
    // A row appearing is cheap and fast, so failing here is decisive: the file
    // input was set and Payhip's uploader did not pick it up.
    const started = await this.page
      .locator(`${SELECTORS.productFileZone} ${SELECTORS.uploadedFileRow}`)
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    if (!started) {
      throw new PayhipTransientError(
        `Payhip never accepted the ebook file (${filename}) — the upload did not start, ` +
          'so no bytes were transferred. The form still reads "No product files added yet". ' +
          'This is usually the connection to Payhip failing rather than the file itself; ' +
          'a slow or unreliable proxy is the common cause.',
      );
    }
    // Completion is the "uploaded" BADGE on the file row.
    //
    // Not the filename as page text: Payhip renders it inside a row whose
    // rename `<input>` lives in a collapsed dropdown, and an input's value is
    // never matched by `getByText`. Waiting on the rename input directly is
    // just as wrong — it is present but hidden, so a perfectly successful 46 MB
    // upload sat there until the ten-minute budget expired, twice, with the
    // finished file visible on screen the whole time.
    await this.page
      .locator(`${SELECTORS.productFileZone} ${SELECTORS.uploadedFileBadge}`)
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
      const input = this.page.locator(`${SELECTORS.productImageZone} input[type="file"]`).first();
      await input.setInputFiles(coverPath);
      // A thumbnail is small and fast; give it a fraction of the ebook's budget
      // rather than letting a stuck image hold the whole run open for minutes.
      // The thumbnail strip carries `display: none` until an image is actually
      // attached, so its becoming visible is the honest signal. Waiting for an
      // `img` instead would match the empty zone's camera placeholder and
      // report success for an upload that never happened.
      await this.page
        .locator(`${SELECTORS.productImageZone} .js-preview-images-zone`)
        .first()
        .waitFor({ state: 'visible', timeout: 60_000 });
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
  async publishAndReadLink(title: string): Promise<{ productKey: string; buyUrl: string }> {
    await this.page.locator(SELECTORS.submit).first().click();

    // Submitting posts the whole form, including the file it just accepted, so
    // give the navigation room before concluding anything about the result.
    // Not fatal on timeout: some flows update in place rather than navigating,
    // and the checks below can still find the link.
    await this.page.waitForLoadState('domcontentloaded', { timeout: 120_000 }).catch(() => {});

    // Payhip surfaces validation failures as inline messages and simply stays
    // on the form — the submit looks like it happened and nothing is created.
    // Checked BEFORE the link read-back so the seller gets Payhip's own words
    // rather than our "no link appeared", which explains nothing.
    //
    // The net is deliberately wide. A single `.error, [role="alert"]` probe
    // found nothing on a form that had plainly refused to submit, and a missed
    // message here is the difference between "Payhip says the file is too
    // large" and a silent dead end.
    const complaint = await this.readValidationErrors();
    if (complaint) throw new PayhipRejected(`Payhip would not accept the product: ${complaint}`);

    const link = await this.readProductLink();
    if (link) return link;

    // The success page did not show a buy link. Before concluding anything,
    // ask the PRODUCT LIST whether the product exists — it is the only source
    // that can tell the two possibilities apart, and they need opposite
    // handling:
    //
    //   found     → the submit worked, only the read-back failed. Recover the
    //               link from the row and carry on as a success. This is the
    //               common case and it used to be reported as a dead end.
    //   not found → the submit never went through, so nothing was created and
    //               retrying is safe. Saying "it was created, do not re-run"
    //               here would strand a seller who has no product at all.
    const listed = await this.findExistingByTitle(title).catch(() => null);
    if (listed) return listed;

    // Nothing on the list either, so the save did not go through and NOTHING
    // was created. Terminal rather than retried: an automatic retry would be
    // safe if this reasoning is right, and would list the book twice if the
    // list lookup is what's broken — and the seller, who can simply look at
    // their dashboard, is far better placed to make that call than a loop is.
    // The message says which way it leans and why.
    throw new PayhipRejected(
      `Saving did not create the product: no buy link appeared and no product named "${title}" ` +
        `is on the product list. Nothing was created, so it is safe to try again. ` +
        `(url=${this.page.url()}, title=${JSON.stringify(await this.pageTitle())}, ` +
        `text=${JSON.stringify(await this.pageSnippet())})`,
    );
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
    // The PRODUCT LIST, not the dashboard. The dashboard shows a welcome panel
    // or store stats and never lists products, so looking there found nothing
    // for every book — which quietly turned this duplicate guard into a no-op.
    await this.page.goto(`${this.baseUrl}${ROUTES.products}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (isLoginUrl(this.page.url())) throw new PayhipSessionExpired();

    const row = this.page.getByText(title, { exact: true }).first();
    const present = await row
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!present) return null;

    // The list does not print buy links — each row links to the product's
    // EDITOR, and that path carries the same key the public link uses. So the
    // key is taken from the nearest edit link to the matched title, and the buy
    // URL composed from it. Composing is safe here in a way that guessing from
    // the title never is: the key came from Payhip, it just arrived by a
    // different door.
    const edit = this.page
      .locator(`a[href*="/product/edit/"]`)
      .filter({ hasText: title })
      .first();
    let href = await edit.getAttribute('href').catch(() => null);

    if (!href) {
      // The title is not always the link text — it may sit in a sibling cell.
      // Walk up from the matched text to the nearest container that holds an
      // edit link, which keeps the pairing correct on a list of many products.
      href = await row
        .locator('xpath=ancestor::*[.//a[contains(@href,"/product/edit/")]][1]')
        .locator('a[href*="/product/edit/"]')
        .first()
        .getAttribute('href')
        .catch(() => null);
    }

    const key = href ? extractEditKey(href) : null;
    if (key) return { productKey: key, buyUrl: `https://payhip.com/b/${key}` };

    // Last resort: the page may still carry a real buy link somewhere.
    return this.readProductLink();
  }

  // ── locators ──────────────────────────────────────────────────────────────
  // Named separately from their uses so the same control is described once.

  /**
   * The nav's Products link — the "you are logged in" marker.
   *
   * Matched on its href rather than its text: the link is an icon plus a
   * `<span>`, so its accessible name depends on how the icon is labelled, while
   * the href is the destination itself and cannot drift without the route
   * changing.
   */
  private navProducts(): Locator {
    return this.page.locator(LOGGED_IN_MARKER).first();
  }

  private titleField(): Locator {
    return this.page.locator(SELECTORS.title).first();
  }

  private priceField(): Locator {
    return this.page.locator(SELECTORS.price).first();
  }

  /**
   * The currency the product will actually be sold in.
   *
   * Payhip sets this per STORE, not per product: the form carries it as a
   * hidden input rather than a control. We cannot change it from here, so the
   * only useful thing to do with it is compare — see `assertCurrency`.
   */
  async readCurrency(): Promise<string | null> {
    const value = await this.page
      .locator(SELECTORS.currency)
      .first()
      .getAttribute('value')
      .catch(() => null);
    return value?.trim().toUpperCase() || null;
  }

  /**
   * Refuse to list the book if the store sells in a different currency than the
   * landing page advertises.
   *
   * Silently listing a "$10" book that actually charges €10 is worse than
   * failing: the sales page and the checkout disagree about what the buyer pays,
   * nothing warns anyone, and the first person to notice is a customer. Since
   * the currency is a store-level setting we cannot fix it here, so the honest
   * move is to stop and name both values.
   *
   * A currency we cannot read is NOT treated as a mismatch — a missing hidden
   * input means Payhip changed the form, and refusing every listing over that
   * would be worse than the risk it guards against.
   */
  async assertCurrency(expected: string): Promise<void> {
    const actual = await this.readCurrency();
    if (!actual || actual === expected.trim().toUpperCase()) return;
    throw new PayhipRejected(
      `This book is priced in ${expected.toUpperCase()} but the Payhip store sells in ${actual}. ` +
        'Payhip sets currency per store, not per product, so change it in Payhip → Settings, ' +
        "or set the book's currency to match. Nothing was created.",
    );
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
