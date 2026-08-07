import { describe, it, expect } from 'vitest';
import { LandingPage, LandingPageId } from '@ebook/core';
import { SupabaseLandingPageRepository } from './SupabaseLandingPageRepository';

const now = new Date('2026-08-05T00:00:00Z');

function pageWithHtml(html: string | null): LandingPage {
  return LandingPage.rehydrate(
    {
      projectId: '11111111-1111-4111-8111-111111111111',
      state: 'DRAFT',
      copy: null,
      palette: null,
      html,
      siteId: null,
      deployId: null,
      url: null,
      inputHash: null,
      error: null,
      engine: 'builtin',
      templateId: null,
      binding: null,
      assets: [],
      fidelity: null,
      createdAt: now,
      updatedAt: now,
    },
    LandingPageId.from('22222222-2222-4222-8222-222222222222'),
  );
}

/** Records whether the write was attempted at all. */
function fakeDb() {
  let upserts = 0;
  const db = {
    from: () => ({
      upsert: async () => {
        upserts++;
        return { error: null };
      },
    }),
  };
  return { db, upserts: () => upserts };
}

describe('SupabaseLandingPageRepository.save', () => {
  it('writes a normal page', async () => {
    const { db, upserts } = fakeDb();
    await new SupabaseLandingPageRepository(db as never).save(pageWithHtml('<html>small</html>'));
    expect(upserts()).toBe(1);
  });

  // The original failure: full-size cover art inlined as base64 pushed the row
  // to tens of MB, and the write came back as a Postgres 57014 on one attempt
  // and a Cloudflare 502 on the next — neither naming the real cause. Fail
  // locally, with the reason, instead of at the gateway.
  it('refuses an oversized page instead of letting the gateway reject it', async () => {
    const { db, upserts } = fakeDb();
    const repo = new SupabaseLandingPageRepository(db as never);
    await expect(repo.save(pageWithHtml('x'.repeat(9 * 1024 * 1024)))).rejects.toThrow(/over the 8MB limit/);
    expect(upserts()).toBe(0);
  });

  it('accepts a page with no html at all', async () => {
    const { db, upserts } = fakeDb();
    await new SupabaseLandingPageRepository(db as never).save(pageWithHtml(null));
    expect(upserts()).toBe(1);
  });
});
