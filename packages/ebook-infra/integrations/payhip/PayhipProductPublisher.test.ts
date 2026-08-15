import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckoutProductDraft } from '@ebook/core';

/**
 * The Payhip adapter, with the entire browser layer mocked.
 *
 * What is worth testing here is POLICY, not Playwright: the order the dashboard
 * is driven in, which failures are retried and which are not, when a session is
 * flagged dead, and how an internal error is mapped onto the provider-agnostic
 * shape the core sees. None of that needs a browser, and a test that launched
 * one would prove less while taking a thousand times longer.
 *
 * What these tests deliberately CANNOT prove is that a selector still matches
 * Payhip's markup. Only the @e2e test (PAYHIP_E2E=1, live account) can, and a
 * green run here says nothing about whether Payhip renamed a button.
 */

// ── the mocked page object ───────────────────────────────────────────────────
// Every dashboard step records its own name, so a test can assert the FLOW —
// that the PDF is not uploaded before the form is filled, that publishing is
// last, that nothing runs at all when the session is already dead.
const calls: string[] = [];
const pageBehaviour = {
  openDashboard: vi.fn(async () => {
    calls.push('openDashboard');
  }),
  findExistingByTitle: vi.fn(async () => {
    calls.push('findExistingByTitle');
    return null as { productKey: string; buyUrl: string } | null;
  }),
  startDigitalProduct: vi.fn(async () => {
    calls.push('startDigitalProduct');
  }),
  assertCurrency: vi.fn(async () => {
    calls.push('assertCurrency');
  }),
  fillDetails: vi.fn(async () => {
    calls.push('fillDetails');
  }),
  uploadPdf: vi.fn(async () => {
    calls.push('uploadPdf');
  }),
  uploadCover: vi.fn(async () => {
    calls.push('uploadCover');
    return true;
  }),
  publishAndReadLink: vi.fn(async () => {
    calls.push('publishAndReadLink');
    return { productKey: 'AbC12', buyUrl: 'https://payhip.com/b/AbC12' };
  }),
};

vi.mock('./PayhipProductPage', async () => {
  const actual = await vi.importActual<typeof import('./PayhipProductPage')>('./PayhipProductPage');
  return {
    ...actual,
    PayhipProductPage: class {
      openDashboard = pageBehaviour.openDashboard;
      findExistingByTitle = pageBehaviour.findExistingByTitle;
      startDigitalProduct = pageBehaviour.startDigitalProduct;
      assertCurrency = pageBehaviour.assertCurrency;
      fillDetails = pageBehaviour.fillDetails;
      uploadPdf = pageBehaviour.uploadPdf;
      uploadCover = pageBehaviour.uploadCover;
      publishAndReadLink = pageBehaviour.publishAndReadLink;
    },
  };
});

// The browser layer: a context that opens, yields a page, and closes. No
// Chromium is launched — `openPayhipContext` is the only thing that would.
vi.mock('./PayhipBrowser', async () => {
  const actual = await vi.importActual<typeof import('./PayhipBrowser')>('./PayhipBrowser');
  return {
    ...actual,
    openPayhipContext: vi.fn(async () => ({
      browser: { close: async () => {} },
      context: {
        close: async () => {},
        newPage: async () => ({ url: () => 'https://payhip.com/dashboard' }),
        storageState: async () => ({ cookies: ['refreshed'] }),
      },
    })),
    // Diagnostics would try to screenshot a page that does not exist.
    withDiagnostics: vi.fn(async (error: Error) => error),
    // Diagnostics too: the real one opens a page and calls out to an IP echo,
    // neither of which a fake context supports and neither of which any
    // behaviour here depends on.
    readExitIp: vi.fn(async () => '203.0.113.7'),
  };
});

const { PayhipProductPublisher } = await import('./PayhipProductPublisher');
const { PayhipSessionExpired, PayhipTransientError, PayhipRejected, PayhipProductCreatedButUnreadable } =
  await import('./PayhipErrors');

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeSessionStore(overrides: Record<string, unknown> = {}) {
  return {
    load: vi.fn(async () => ({
      storageState: { cookies: [] },
      needsReauth: false,
      note: null,
      savedAt: new Date(),
    })),
    isConfigured: vi.fn(async () => true),
    saveConnected: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    markNeedsReauth: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeDraft(overrides: Partial<CheckoutProductDraft> = {}): CheckoutProductDraft {
  return {
    externalId: '11111111-1111-4111-8111-111111111111',
    title: 'The Mechanic Bible',
    description: 'Fix it yourself',
    priceCents: 1900,
    currency: 'USD',
    pdf: { bytes: new Uint8Array([1, 2, 3]), filename: 'book.pdf', contentType: 'application/pdf' },
    cover: { bytes: new Uint8Array([4, 5]), filename: 'cover.jpg', contentType: 'image/jpeg' },
    ...overrides,
  };
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
} as never;

const config = {
  baseUrl: 'https://payhip.com',
  timeoutMs: 1_000,
  debugDir: '/tmp/payhip-test',
  // Same two attempts as production, without the fifteen-second wait between
  // them. Fake timers cannot substitute here: the flow interleaves real
  // filesystem work with the delay, so advancing the clock deadlocks.
  backoffMs: [0, 0],
};

function build(sessions = makeSessionStore()) {
  return { publisher: new PayhipProductPublisher(sessions as never, config, logger), sessions };
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  // vi.clearAllMocks() wipes the default implementations above, so the happy
  // path is restored here and individual tests override what they need.
  pageBehaviour.findExistingByTitle.mockImplementation(async () => {
    calls.push('findExistingByTitle');
    return null;
  });
  pageBehaviour.uploadCover.mockImplementation(async () => {
    calls.push('uploadCover');
    return true;
  });
  pageBehaviour.publishAndReadLink.mockImplementation(async () => {
    calls.push('publishAndReadLink');
    return { productKey: 'AbC12', buyUrl: 'https://payhip.com/b/AbC12' };
  });
  for (const step of [
    'openDashboard',
    'startDigitalProduct',
    'assertCurrency',
    'fillDetails',
    'uploadPdf',
  ] as const) {
    pageBehaviour[step].mockImplementation(async () => {
      calls.push(step);
    });
  }
});

describe('the automation flow', () => {
  it('drives the dashboard in order: form before files, publish last', async () => {
    const { publisher } = build();

    const result = await publisher.createProduct(makeDraft());

    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([
      'openDashboard',
      'findExistingByTitle',
      'startDigitalProduct',
      // Before the upload, deliberately: a currency mismatch cannot be fixed
      // from here, so discovering it after a 48 MB upload only wastes time.
      'assertCurrency',
      'fillDetails',
      'uploadPdf',
      'uploadCover',
      'publishAndReadLink',
    ]);
  });

  it('skips the cover upload when the book has none', async () => {
    const { publisher } = build();

    await publisher.createProduct(makeDraft({ cover: undefined }));

    expect(calls).not.toContain('uploadCover');
    expect(calls).toContain('publishAndReadLink');
  });

  it('refreshes the stored session after a successful run', async () => {
    // Payhip's session window slides. Without this the operator is sent back to
    // the connect command far sooner than they need to be.
    const { publisher, sessions } = build();

    await publisher.createProduct(makeDraft());

    expect(sessions.refresh).toHaveBeenCalledWith({ cookies: ['refreshed'] });
  });

  it('returns the product key and buy link read off the page', async () => {
    const { publisher } = build();

    const result = await publisher.createProduct(makeDraft());

    if (result.isFail()) throw new Error(result.error.message);
    expect(result.value.productKey).toBe('AbC12');
    expect(result.value.buyUrl).toBe('https://payhip.com/b/AbC12');
  });
});

describe('adopting a product a previous run left behind', () => {
  /**
   * The gap the DB idempotency guard cannot close: a run that published
   * successfully and then died before the link was persisted. Our records show
   * nothing; the store shows a product. Creating another one would list the
   * book twice.
   */
  it('returns the existing product instead of creating a duplicate', async () => {
    pageBehaviour.findExistingByTitle.mockImplementation(async () => {
      calls.push('findExistingByTitle');
      return { productKey: 'OLD99', buyUrl: 'https://payhip.com/b/OLD99' };
    });
    const { publisher } = build();

    const result = await publisher.createProduct(makeDraft());

    if (result.isFail()) throw new Error(result.error.message);
    expect(result.value.productKey).toBe('OLD99');
    expect(calls).not.toContain('startDigitalProduct');
    expect(calls).not.toContain('publishAndReadLink');
  });
});

describe('error mapping and retries', () => {
  it('retries a transient failure and succeeds on the second attempt', async () => {
    let attempts = 0;
    pageBehaviour.openDashboard.mockImplementation(async () => {
      attempts++;
      calls.push('openDashboard');
      if (attempts === 1) throw new PayhipTransientError('navigation timeout');
    });
    const { publisher } = build();

    const result = await publisher.createProduct(makeDraft());

    expect(result.isOk()).toBe(true);
    expect(attempts).toBe(2);
  });

  it('never retries an expired session, and flags it for re-connect', async () => {
    pageBehaviour.openDashboard.mockImplementation(async () => {
      calls.push('openDashboard');
      throw new PayhipSessionExpired();
    });
    const { publisher, sessions } = build();

    const result = await publisher.createProduct(makeDraft());

    expect(result.isFail()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.kind).toBe('session-expired');
    // Retrying proves nothing: the second attempt is no more logged in.
    expect(calls.filter((c) => c === 'openDashboard')).toHaveLength(1);
    // Flagged, so the UI stops offering a button that cannot work.
    expect(sessions.markNeedsReauth).toHaveBeenCalled();
    // And the message names the command that fixes it.
    expect(result.error.message).toMatch(/payhip:connect/);
  });

  /**
   * Payhip sets currency per STORE, not per product. Listing a book the sales
   * page advertises as "$10" into a store that charges €10 means the page and
   * the checkout disagree about what the buyer pays, with nothing warning
   * anyone — the first person to notice is a customer.
   */
  it('stops before uploading anything when the store currency disagrees', async () => {
    pageBehaviour.assertCurrency.mockImplementation(async () => {
      calls.push('assertCurrency');
      throw new PayhipRejected('This book is priced in USD but the Payhip store sells in EUR.');
    });
    const { publisher } = build();

    const result = await publisher.createProduct(makeDraft());

    expect(result.isFail()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.kind).toBe('rejected');
    // The 48 MB upload never starts, and nothing is published.
    expect(calls).not.toContain('uploadPdf');
    expect(calls).not.toContain('publishAndReadLink');
  });

  it('never retries a rejection — Payhip would reject it identically', async () => {
    pageBehaviour.publishAndReadLink.mockImplementation(async () => {
      calls.push('publishAndReadLink');
      throw new PayhipRejected('Payhip rejected the product: file too large');
    });
    const { publisher } = build();

    const result = await publisher.createProduct(makeDraft());

    expect(result.isFail()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.kind).toBe('rejected');
    expect(calls.filter((c) => c === 'publishAndReadLink')).toHaveLength(1);
  });

  /**
   * The most expensive mistake available to this module: the product WAS
   * created and only the read-back failed. Retrying lists the book twice, so
   * this must stop dead and say so.
   */
  it('never retries once the product may already exist', async () => {
    pageBehaviour.publishAndReadLink.mockImplementation(async () => {
      calls.push('publishAndReadLink');
      throw new PayhipProductCreatedButUnreadable('no link appeared');
    });
    const { publisher } = build();

    const result = await publisher.createProduct(makeDraft());

    expect(result.isFail()).toBe(true);
    if (result.isOk()) return;
    expect(calls.filter((c) => c === 'publishAndReadLink')).toHaveLength(1);
    expect(result.error.kind).toBe('rejected');
    // The operator has to be told not to press the button again, and where to
    // find the link by hand.
    expect(result.error.message).toMatch(/already listed/i);
  });

  it('treats a Playwright timeout as transient even though it is a plain Error', async () => {
    let attempts = 0;
    pageBehaviour.openDashboard.mockImplementation(async () => {
      attempts++;
      calls.push('openDashboard');
      if (attempts === 1) throw new Error('page.goto: Timeout 45000ms exceeded');
    });
    const { publisher } = build();

    const result = await publisher.createProduct(makeDraft());

    expect(result.isOk()).toBe(true);
    expect(attempts).toBe(2);
  });

  it('reports a missing session as not-configured, not as an expiry', async () => {
    // Two different problems with two different fixes: one needs a first-time
    // setup, the other needs a re-login. Collapsing them would send the
    // operator looking for a session that never existed.
    const { publisher } = build(makeSessionStore({ load: vi.fn(async () => null) }));

    const result = await publisher.createProduct(makeDraft());

    expect(result.isFail()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.kind).toBe('not-configured');
  });

  it('refuses to run at all on a session already flagged for re-connect', async () => {
    const { publisher } = build(
      makeSessionStore({
        load: vi.fn(async () => ({
          storageState: { cookies: [] },
          needsReauth: true,
          note: 'flagged last run',
          savedAt: new Date(),
        })),
      }),
    );

    const result = await publisher.createProduct(makeDraft());

    expect(result.isFail()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.kind).toBe('session-expired');
    expect(calls).toHaveLength(0);
  });
});
