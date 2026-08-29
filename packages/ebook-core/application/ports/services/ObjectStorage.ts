import type { Result } from '../../../domain/shared/Result';

export interface ObjectStorage {
  put(bucket: string, path: string, data: Uint8Array, contentType: string): Promise<Result<{ path: string }>>;
  /**
   * Time-limited URL the BROWSER uploads directly to, bypassing the app server.
   *
   * Reference books are whole books — routinely tens of megabytes, well past
   * the ~4.5MB request-body limit a serverless route can accept. The bytes must
   * never pass through the app.
   */
  signedUploadUrl(bucket: string, path: string): Promise<Result<{ url: string; token: string }>>;
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
  /**
   * Whether an object is present, without transferring its bytes. Callers that
   * can REBUILD a missing object (e.g. re-downloading audio a previous run
   * deleted) use this to tell "gone" from "storage is unhappy", which a failed
   * download can't distinguish.
   */
  exists(bucket: string, path: string): Promise<boolean>;
  remove(bucket: string, path: string): Promise<Result<void>>;
}
