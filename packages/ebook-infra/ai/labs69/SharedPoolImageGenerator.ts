import { Result, type ImageGenerator, type GeneratedImage } from '@ebook/core';
import { getEnv } from '@/lib/env';
import { withAccountSlot } from '@/lib/synthetic/rate-limit';

/**
 * Gates an ImageGenerator behind the app-wide 69labs concurrency pool.
 *
 * WHY THIS EXISTS (port note): the ebook product and the video engines bill the
 * SAME 69labs account. The ported Labs69ImageGenerator has no concurrency
 * control of its own — it fires a request per call — so with `extra-content` at
 * concurrency 3 and illustrations fanning out per chapter, a book being
 * illustrated would push the account past its ceiling and starve in-flight video
 * renders (the failure mode recorded in the "69labs poll-budget starvation" and
 * "synthetic concurrency caps" notes).
 *
 * lib/synthetic/rate-limit.ts already owns the fix: a Redis-backed, per-account
 * slot pool shared by every process on the cluster, with a heartbeated lease and
 * release-on-throw. Wrapping the adapter — rather than editing it — keeps the
 * ported code untouched while putting ebook illustrations under the same ceiling
 * as every other 69labs caller, so the two products queue against each other
 * instead of overcommitting the account.
 *
 * The wrapped generator is expected to be the 69labs one. A fallback generator
 * that does NOT hit 69labs (e.g. the OpenAI cover generator) must not be wrapped
 * — it would consume 69labs slots it doesn't need.
 */
export class SharedPoolImageGenerator implements ImageGenerator {
  /**
   * @param inner    the 69labs-backed generator to gate
   * @param accountId stable per-account id for the slot pool. Must be derived
   *                  from the API key the way lib/synthetic/sixtynine-labs.ts
   *                  does it (`key.slice(0, 10)`) so BOTH products contend for
   *                  the SAME semaphore — a different id would silently create a
   *                  second, independent pool and defeat the whole point.
   */
  constructor(
    private readonly inner: ImageGenerator,
    private readonly accountId: string,
  ) {}

  async generate(input: { prompt: string; size?: string }): Promise<Result<GeneratedImage>> {
    // SIXTYNINE_ACCOUNT_CONCURRENCY, NOT SIXTYNINE_IMAGE_CONCURRENCY. The former
    // is the GLOBAL Redis-coordinated per-account ceiling that
    // lib/synthetic/sixtynine-labs.ts passes to withAccountSlot; the latter is a
    // per-key/per-process number. Using the wrong one here would size this
    // caller's view of the pool differently from the video engines' and defeat
    // the point of sharing it.
    const cap = getEnv().SIXTYNINE_ACCOUNT_CONCURRENCY;
    try {
      return await withAccountSlot(this.accountId, cap, () => this.inner.generate(input));
    } catch (err) {
      // A slot-acquire timeout means the account was saturated for the whole
      // window. Illustrations are best-effort, so surface it as a normal
      // Result.fail — the caller skips the image rather than failing the book.
      return Result.fail(`69labs slot unavailable: ${String(err)}`);
    }
  }
}
