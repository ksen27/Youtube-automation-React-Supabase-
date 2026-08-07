import type { Result } from '../../../domain/shared/Result';

export interface SiteFile {
  /** Path inside the deployed site, e.g. 'index.html' or 'assets/cover.jpg'. */
  path: string;
  bytes: Uint8Array;
}

export interface PublishInput {
  /** Existing site to redeploy over; omitted on the first publish. */
  siteId?: string | undefined;
  /** Preferred subdomain, slugified from the book title. Must be unique
   * globally, so the adapter is free to append a suffix on collision. */
  preferredName: string;
  files: SiteFile[];
}

export interface PublishOutput {
  siteId: string;
  deployId: string;
  url: string;
}

/**
 * Publishes a set of static files to a public URL. Netlify is the only
 * implementation today; the port exists so the use case never learns about it.
 */
export interface SitePublisher {
  /** True when the adapter is configured (i.e. an API token is present). */
  isConfigured(): boolean;
  publish(input: PublishInput): Promise<Result<PublishOutput>>;
}
