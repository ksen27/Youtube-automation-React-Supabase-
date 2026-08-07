import { createHash } from 'node:crypto';
import { Result, type PublishInput, type PublishOutput, type SiteFile, type SitePublisher } from '@ebook/core';

const API = 'https://api.netlify.com/api/v1';

/**
 * Publishes a landing page to Netlify using the file-digest deploy API:
 *
 *   1. POST /sites                     → create the site (first publish only)
 *   2. POST /sites/:id/deploys         → declare {path: sha1}; Netlify replies
 *                                        with the subset it doesn't already hold
 *   3. PUT  /deploys/:id/files/:path   → upload only those
 *   4. GET  /deploys/:id               → poll until 'ready'
 *
 * The digest flow is used rather than a zip upload because a redeploy that only
 * changes the copy re-uploads the HTML and not the cover image — and because it
 * needs no archiving dependency.
 */
export class NetlifyDeployer implements SitePublisher {
  constructor(
    private readonly token: string,
    /** Optional team slug; required only when the token can see several teams. */
    private readonly accountSlug: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return this.token.trim().length > 0;
  }

  async publish(input: PublishInput): Promise<Result<PublishOutput>> {
    if (!this.isConfigured()) return Result.fail('Netlify is not configured (NETLIFY_AUTH_TOKEN is unset)');
    if (input.files.length === 0) return Result.fail('Nothing to deploy');

    try {
      const site = input.siteId ? { id: input.siteId } : await this.createSite(input.preferredName);
      if ('error' in site) return Result.fail(site.error);

      const digest: Record<string, string> = {};
      const bySha = new Map<string, SiteFile>();
      for (const f of input.files) {
        const path = f.path.startsWith('/') ? f.path : `/${f.path}`;
        const sha = createHash('sha1').update(Buffer.from(f.bytes)).digest('hex');
        digest[path] = sha;
        bySha.set(sha, f);
      }

      const created = await this.api<{ id: string; required?: string[] }>(`/sites/${site.id}/deploys`, {
        method: 'POST',
        body: JSON.stringify({ files: digest, async: false }),
      });
      if (created.isFail()) return Result.fail(`Deploy create failed: ${created.error}`);
      const deployId = created.value.id;

      // `required` lists the SHAs Netlify is missing. An empty list means the
      // content is byte-identical to what is already live — nothing to upload.
      for (const sha of created.value.required ?? []) {
        const file = bySha.get(sha);
        if (!file) continue;
        const path = file.path.startsWith('/') ? file.path : `/${file.path}`;
        const uploaded = await this.upload(deployId, path, file.bytes);
        if (uploaded.isFail()) return Result.fail(`Upload of ${path} failed: ${uploaded.error}`);
      }

      const ready = await this.waitForReady(deployId);
      if (ready.isFail()) return Result.fail(ready.error);

      return Result.ok({
        siteId: site.id,
        deployId,
        // ssl_url is the https:// form and the one worth handing to a buyer.
        url: ready.value.ssl_url || ready.value.url || `https://${input.preferredName}.netlify.app`,
      });
    } catch (e) {
      return Result.fail(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Netlify subdomains are globally unique, so a good name is frequently taken.
   * Retry with a short random suffix rather than failing the publish — the user
   * cares that the page is live, and can rename the site later in Netlify.
   */
  private async createSite(preferredName: string): Promise<{ id: string } | { error: string }> {
    const base = slugify(preferredName);
    const path = this.accountSlug ? `/${this.accountSlug}/sites` : '/sites';
    for (let attempt = 0; attempt < 5; attempt++) {
      const name = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      const res = await this.api<{ id: string }>(path, { method: 'POST', body: JSON.stringify({ name }) });
      if (res.isOk()) return { id: res.value.id };
      // 422 is Netlify's "subdomain already taken"; anything else is a real error.
      if (!res.error.startsWith('422')) return { error: `Site creation failed: ${res.error}` };
    }
    return { error: `Could not find an available Netlify subdomain for "${base}"` };
  }

  private async upload(deployId: string, path: string, bytes: Uint8Array): Promise<Result<void>> {
    const res = await this.fetchImpl(`${API}/deploys/${deployId}/files${encodePath(path)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: Buffer.from(bytes),
    });
    if (!res.ok) return Result.fail(`${res.status} ${await safeText(res)}`);
    return Result.ok();
  }

  /**
   * A deploy is accepted before it is live. Poll until Netlify reports 'ready',
   * so the URL we hand back actually serves the page rather than a 404.
   */
  private async waitForReady(deployId: string): Promise<Result<{ ssl_url?: string; url?: string }>> {
    const deadline = Date.now() + 120_000;
    let delay = 1000;
    while (Date.now() < deadline) {
      const res = await this.api<{ state: string; ssl_url?: string; url?: string; error_message?: string }>(
        `/deploys/${deployId}`,
        { method: 'GET' },
      );
      if (res.isFail()) return Result.fail(`Deploy status check failed: ${res.error}`);
      const { state } = res.value;
      if (state === 'ready') return Result.ok(res.value);
      if (state === 'error') return Result.fail(res.value.error_message ?? 'Netlify reported a failed deploy');
      await sleep(delay);
      delay = Math.min(delay * 1.5, 8000);
    }
    return Result.fail('Timed out waiting for the Netlify deploy to go live');
  }

  private async api<T>(path: string, init: RequestInit): Promise<Result<T>> {
    const res = await this.fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) return Result.fail(`${res.status} ${await safeText(res)}`);
    return Result.ok((await res.json()) as T);
  }
}

/** Netlify site names: lowercase alphanumerics and hyphens, ≤ 63 characters. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop the accents NFKD split off
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 46)
    .replace(/-+$/g, '');
  return slug.length >= 3 ? slug : `book-${slug || 'page'}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Each segment is encoded separately so the '/' separators survive. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
