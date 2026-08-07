import type { Result } from '../../../domain/shared/Result';

export interface ObjectStorage {
  put(bucket: string, path: string, data: Uint8Array, contentType: string): Promise<Result<{ path: string }>>;
  /** Time-limited signed URL for client download. */
  signedUrl(bucket: string, path: string, expiresInSeconds: number): Promise<Result<string>>;
  /**
   * Object contents as a base64 `data:` URI, for inlining into rendered
   * documents (e.g. the cover art) so the renderer needs no network fetch.
   */
  getDataUri(bucket: string, path: string): Promise<Result<string>>;
  /** Raw object contents, for callers that need the bytes themselves (e.g.
   * sampling a cover's colours, or bundling it into a site deploy). */
  getBytes(bucket: string, path: string): Promise<Result<{ bytes: Uint8Array; contentType: string }>>;
  remove(bucket: string, path: string): Promise<Result<void>>;
}
