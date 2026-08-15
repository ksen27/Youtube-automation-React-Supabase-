import type { Result } from '../../../domain/shared/Result';

/**
 * Creating the store product a landing page's buy button points at.
 *
 * Deliberately provider-agnostic, exactly as `landingCheckoutUrl` is: the domain
 * cares that a buyer has somewhere to pay, not that the somewhere is Payhip.
 * The only adapter today drives Payhip's dashboard in a browser (they have no
 * product-creation API — only coupons and license keys), but a Gumroad or
 * Lemon Squeezy adapter would implement this same port with a real HTTP client
 * and nothing above this line would change.
 */

/** The bytes of a file to upload, plus the name the store should show for it. */
export interface CheckoutProductFile {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export interface CheckoutProductDraft {
  /**
   * OUR id for the thing being sold — the project id.
   *
   * Carried into the product's title/description so a half-finished run can be
   * RECOGNISED on the store next time. Idempotency is enforced by the caller
   * against our own DB, but a crash between "store published" and "we wrote the
   * row" leaves a product we have no record of; without an external id in the
   * listing the only recovery is a human reading titles.
   */
  externalId: string;
  title: string;
  description: string;
  priceCents: number;
  currency: string;
  /** The book itself — what the buyer downloads. */
  pdf: CheckoutProductFile;
  /** Cover art for the product listing. Optional: a book may not have one yet. */
  cover?: CheckoutProductFile | undefined;
}

export interface PublishedCheckoutProduct {
  /** The store's own id for the product — `XXXX` in `payhip.com/b/XXXX`. */
  productKey: string;
  /** The public link a buyer opens. Written into the landing page verbatim. */
  buyUrl: string;
  createdAt: Date;
}

/**
 * Why a publish attempt failed, in the terms the CALLER can act on.
 *
 * `session-expired` is the one an operator must personally fix (re-run the
 * headed login), so it is never retried and never buried in a generic message.
 * `transient` is what a retry might clear — a navigation timeout, a slow upload.
 * `rejected` is the store refusing the product (bad price, file too large); a
 * retry would fail identically.
 */
export type CheckoutPublishFailure = 'session-expired' | 'transient' | 'rejected' | 'not-configured';

export interface CheckoutPublishError {
  kind: CheckoutPublishFailure;
  message: string;
  /**
   * Where the screenshot / HTML snapshot of the failed page were written, when
   * the adapter captured any. Surfaced up to the operator because "it timed
   * out" is unactionable and "it timed out, here is the page it was looking at"
   * is a bug report.
   */
  debugPaths?: string[] | undefined;
}

export interface CreateProductOptions {
  /**
   * Create a NEW product even if one with this title already exists on the
   * store.
   *
   * Off by default, because adopting an existing listing is what stops a run
   * that published and then died from listing the same book twice. But that
   * same guard makes "create it again" impossible — it would find the old
   * product and hand back its link — so a caller who has deliberately asked to
   * regenerate must be able to switch it off.
   */
  force?: boolean | undefined;
}

export interface CheckoutProductPublisher {
  /** False when no session/credentials are set up, so the UI can say so up front. */
  isConfigured(): boolean;
  createProduct(
    draft: CheckoutProductDraft,
    options?: CreateProductOptions,
  ): Promise<Result<PublishedCheckoutProduct, CheckoutPublishError>>;
}
