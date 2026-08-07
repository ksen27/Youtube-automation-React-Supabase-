import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { NetlifyDeployer, slugify } from './NetlifyDeployer';

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

/** Scripted Netlify: each entry is one queued response, matched in order. */
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift() ?? { status: 500, body: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const file = { path: 'index.html', bytes: new TextEncoder().encode('<html>hi</html>') };
/** Netlify keys uploads by content SHA-1, so the fake has to speak the real one. */
const FILE_SHA = createHash('sha1').update(Buffer.from(file.bytes)).digest('hex');

describe('NetlifyDeployer', () => {
  it('reports itself unconfigured without a token, and refuses to publish', async () => {
    const deployer = new NetlifyDeployer('', undefined);
    expect(deployer.isConfigured()).toBe(false);
    const result = await deployer.publish({ preferredName: 'book', files: [file] });
    expect(result.isFail()).toBe(true);
  });

  it('creates a site, uploads only the files Netlify asks for, and waits for ready', async () => {
    const { impl, calls } = fakeFetch([
      { status: 201, body: { id: 'site-1' } },
      { status: 200, body: { id: 'dep-1', required: [FILE_SHA] } },
      { status: 200, body: {} }, // the upload
      { status: 200, body: { state: 'ready', ssl_url: 'https://book.netlify.app' } },
    ]);

    const result = await new NetlifyDeployer('tok', undefined, impl).publish({
      preferredName: 'The Mechanic Bible',
      files: [file],
    });

    expect(result.isOk()).toBe(true);
    expect((result as { value: { url: string } }).value.url).toBe('https://book.netlify.app');
    expect(calls[0]).toMatchObject({ url: 'https://api.netlify.com/api/v1/sites', method: 'POST' });
    expect((calls[0]!.body as { name: string }).name).toBe('the-mechanic-bible');
    // Paths in the digest are absolute, which is what the API expects.
    expect(Object.keys((calls[1]!.body as { files: Record<string, string> }).files)).toEqual(['/index.html']);
    expect(calls[2]).toMatchObject({
      url: 'https://api.netlify.com/api/v1/deploys/dep-1/files/index.html',
      method: 'PUT',
    });
  });

  it('skips the upload entirely when Netlify already holds the content', async () => {
    const { impl, calls } = fakeFetch([
      { status: 201, body: { id: 'site-1' } },
      { status: 200, body: { id: 'dep-1', required: [] } },
      { status: 200, body: { state: 'ready', ssl_url: 'https://book.netlify.app' } },
    ]);

    const result = await new NetlifyDeployer('tok', undefined, impl).publish({
      preferredName: 'book',
      files: [file],
    });

    expect(result.isOk()).toBe(true);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('reuses an existing site instead of creating a second one', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'dep-2', required: [] } },
      { status: 200, body: { state: 'ready', ssl_url: 'https://book.netlify.app' } },
    ]);

    await new NetlifyDeployer('tok', undefined, impl).publish({
      siteId: 'site-existing',
      preferredName: 'book',
      files: [file],
    });

    expect(calls[0]!.url).toContain('/sites/site-existing/deploys');
  });

  it('retries with a new subdomain when the preferred one is taken', async () => {
    const { impl, calls } = fakeFetch([
      { status: 422, body: { errors: { subdomain: ['must be unique'] } } },
      { status: 201, body: { id: 'site-2' } },
      { status: 200, body: { id: 'dep-1', required: [] } },
      { status: 200, body: { state: 'ready', ssl_url: 'https://book-ab12cd.netlify.app' } },
    ]);

    const result = await new NetlifyDeployer('tok', undefined, impl).publish({
      preferredName: 'book',
      files: [file],
    });

    expect(result.isOk()).toBe(true);
    const first = (calls[0]!.body as { name: string }).name;
    const second = (calls[1]!.body as { name: string }).name;
    expect(first).toBe('book');
    expect(second).toMatch(/^book-[a-z0-9]{1,6}$/);
  });

  it('fails loudly when the deploy errors', async () => {
    const { impl } = fakeFetch([
      { status: 201, body: { id: 'site-1' } },
      { status: 200, body: { id: 'dep-1', required: [] } },
      { status: 200, body: { state: 'error', error_message: 'build failed' } },
    ]);

    const result = await new NetlifyDeployer('tok', undefined, impl).publish({
      preferredName: 'book',
      files: [file],
    });

    expect(result.isFail()).toBe(true);
    expect((result as { error: string }).error).toContain('build failed');
  });

  it('scopes site creation to a team when one is configured', async () => {
    const { impl, calls } = fakeFetch([
      { status: 201, body: { id: 'site-1' } },
      { status: 200, body: { id: 'dep-1', required: [] } },
      { status: 200, body: { state: 'ready', ssl_url: 'https://x.netlify.app' } },
    ]);

    await new NetlifyDeployer('tok', 'my-team', impl).publish({ preferredName: 'book', files: [file] });

    expect(calls[0]!.url).toBe('https://api.netlify.com/api/v1/my-team/sites');
  });
});

describe('slugify', () => {
  it('produces a valid Netlify subdomain from a book title', () => {
    expect(slugify('The Mechanic Bible')).toBe('the-mechanic-bible');
    expect(slugify('101 Recipes: Weeknight Dinners!')).toBe('101-recipes-weeknight-dinners');
    expect(slugify('Café Crème')).toBe('cafe-creme');
  });

  it('never emits a name Netlify would reject', () => {
    for (const input of ['', '!!!', 'a', '—', 'x'.repeat(200)]) {
      const slug = slugify(input);
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      expect(slug.length).toBeGreaterThanOrEqual(3);
      expect(slug.length).toBeLessThanOrEqual(63);
    }
  });
});
