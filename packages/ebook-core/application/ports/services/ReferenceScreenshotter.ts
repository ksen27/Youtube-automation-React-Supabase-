import type { Result } from '../../../domain/shared/Result';

/** One captured slice of a reference page, ready to attach to a prompt. */
export interface ReferenceShot {
  /** e.g. "image/png". */
  mediaType: string;
  /** Base64 payload WITHOUT the `data:` URI prefix. */
  dataBase64: string;
}

/**
 * Renders the reference sales page in a real browser and captures it.
 *
 * The pruned markup the fetcher returns conveys STRUCTURE — what elements exist
 * in what order. It does not convey the things that make a page look like
 * itself: spacing, rhythm, type scale, how much air sits around a card. Those
 * only exist once the page is painted, which is why the client's instruction
 * was "take screenshots of the reference and the ai will learn it".
 *
 * SECURITY: the URL originates from a user, and this drives a real browser
 * inside the worker's network — a far more capable SSRF sink than a plain
 * fetch. Implementations MUST refuse non-public addresses before navigating.
 */
export interface ReferenceScreenshotter {
  /**
   * Captures the page top-to-bottom as a small number of viewport-sized slices.
   * Sliced rather than one full-page image because a long sales page rendered
   * whole is mostly unreadable once scaled to fit the model's image limits.
   */
  capture(url: string): Promise<Result<ReferenceShot[]>>;

  /**
   * Renders HTML we generated and captures it, for visual review before the
   * layout is accepted.
   *
   * The page contract checks everything mechanical — placeholders, sections,
   * balanced tags, colours, slots — and a layout can pass all of it while
   * still putting a portrait over its own header or squeezing a list into
   * twelve-character columns. Those are only visible once painted.
   */
  captureHtml(html: string): Promise<Result<ReferenceShot[]>>;
}
