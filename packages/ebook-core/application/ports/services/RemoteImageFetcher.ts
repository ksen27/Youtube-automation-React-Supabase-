import type { Result } from '../../../domain/shared/Result';

/**
 * Fetches a remote image (e.g. the YouTube channel avatar that becomes the
 * page's logo) and returns it as a `data:` URI for embedding. Implementations
 * MUST apply the same SSRF discipline as the reference-page fetcher: the URL
 * ultimately originates outside our control.
 */
export interface RemoteImageFetcher {
  fetchDataUri(url: string): Promise<Result<string>>;
  /**
   * The same fetch, returning the raw bytes instead. Callers that re-encode
   * before embedding want these — going via a data URI would base64 the image
   * once only to decode it again.
   */
  fetchBytes(url: string): Promise<Result<{ bytes: Uint8Array; contentType: string }>>;
}
