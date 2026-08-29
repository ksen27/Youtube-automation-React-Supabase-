import { describe, expect, it } from 'vitest';
import { Result } from '../../domain/shared/Result';
import { ReferenceBook } from '../../domain/reference/ReferenceBook';
import { ReferenceBookId } from '../../domain/reference/ReferenceBookId';
import { ReferenceSection } from '../../domain/reference/ReferenceSection';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { ReferenceBookRepository } from '../ports/repositories/ReferenceBookRepository';
import type { ReferenceTextExtractor } from '../ports/services/ReferenceTextExtractor';
import type { JobQueue } from '../ports/services/JobQueue';
import type { ExtractedSection } from '../../domain/reference/sectionText';
import { IngestReferenceUploadUseCase } from './IngestReferenceUploadUseCase';
import { StartReferenceUploadUseCase, MAX_REFERENCE_BYTES } from './StartReferenceUploadUseCase';

const NOW = new Date('2026-08-29T00:00:00Z');
const ID = '11111111-1111-4111-8111-111111111111';
const PDF = 'application/pdf';

function uploaded() {
  const r = ReferenceBook.uploaded({
    id: ReferenceBookId.from(ID),
    ownerId: 'owner-1',
    title: 'The Sourdough Book',
    storagePath: 'owner-1/abc.pdf',
    contentType: PDF,
    byteSize: 5000,
    now: NOW,
  });
  if (r.isFail()) throw new Error(r.error);
  return r.value;
}

const chapters = (count: number, words = 500): ExtractedSection[] =>
  Array.from({ length: count }, (_, i) => ({
    title: `Chapter ${i + 1}`,
    content: Array(words).fill('prose').join(' '),
  }));

function ingest(options: {
  book?: ReferenceBook | null;
  bytes?: Result<{ bytes: Uint8Array; contentType: string }>;
  extracted?: Result<ExtractedSection[]>;
}) {
  const saved: ReferenceBook[] = [];
  const enqueued: string[] = [];
  const book = options.book === undefined ? uploaded() : options.book;
  const references = {
    findById: async () => book,
    save: async (b: ReferenceBook) => void saved.push(b),
  } as unknown as ReferenceBookRepository;
  const storage = {
    getBytes: async () => options.bytes ?? Result.ok({ bytes: new Uint8Array([1]), contentType: PDF }),
  } as unknown as ObjectStorage;
  const extractor = {
    extract: async () => options.extracted ?? Result.ok(chapters(4)),
  } as unknown as ReferenceTextExtractor;
  const queue = { enqueue: async (q: string) => void enqueued.push(q) } as unknown as JobQueue;
  return {
    uc: new IngestReferenceUploadUseCase(references, storage, extractor, queue, { now: () => NOW }),
    saved,
    enqueued,
    book,
  };
}

describe('IngestReferenceUploadUseCase', () => {
  it('parses the file into sections and queues the style extraction', async () => {
    const { uc, enqueued, book } = ingest({});
    const result = await uc.execute({ referenceBookId: ID });
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.sections).toBe(4);
    expect(book!.status).toBe('DONE');
    expect(book!.sections).toHaveLength(4);
    expect(enqueued).toEqual(['reference-extract']);
  });

  // BullMQ can deliver a job twice, and re-parsing a 300-page PDF to produce
  // identical sections is pure cost.
  it('is idempotent once the reference already has its text', async () => {
    const book = uploaded();
    book.attachSections(
      chapters(3, 800).map((c, i) => ReferenceSection.create({ position: i, title: c.title, content: c.content })),
      NOW,
    );
    const { uc, enqueued } = ingest({ book });
    const result = await uc.execute({ referenceBookId: ID });
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.outcome).toBe('already-ingested');
    expect(enqueued).toHaveLength(0);
  });

  // The scanned-book case. The parse "succeeds" with almost nothing, and the
  // reference must end up FAILED with a diagnosis rather than selectable.
  it('fails the reference when the file yields too little text', async () => {
    const { uc, enqueued, book } = ingest({ extracted: Result.ok(chapters(1, 20)) });
    const result = await uc.execute({ referenceBookId: ID });
    expect(result.isFail()).toBe(true);
    expect(book!.status).toBe('FAILED');
    expect(book!.error).toMatch(/scanned images, protected, or not a book/);
    expect(enqueued).toHaveLength(0);
  });

  it('records an unreadable file on the reference rather than only throwing', async () => {
    const { uc, book } = ingest({ extracted: Result.fail('Could not read this file — it may be corrupt') });
    const result = await uc.execute({ referenceBookId: ID });
    expect(result.isFail()).toBe(true);
    expect(book!.status).toBe('FAILED');
    expect(book!.error).toMatch(/corrupt/);
  });

  // The row exists but the browser upload never finished. No retry uploads it.
  it('records a missing file instead of retrying forever', async () => {
    const { uc, book } = ingest({ bytes: Result.fail('object not found') });
    const result = await uc.execute({ referenceBookId: ID });
    expect(result.isFail()).toBe(true);
    expect(book!.status).toBe('FAILED');
    expect(book!.error).toMatch(/could not be read back from storage/);
  });

  it('fails cleanly for a reference that has no uploaded file', async () => {
    const generated = ReferenceBook.fromGeneratedBook({
      id: ReferenceBookId.from(ID),
      ownerId: 'owner-1',
      title: 'Generated',
      originProjectId: '22222222-2222-4222-8222-222222222222',
      sections: [ReferenceSection.create({ position: 0, title: null, content: 'x' })],
      now: NOW,
    });
    if (generated.isFail()) throw new Error(generated.error);
    // A generated book is born DONE, so clear that to reach the no-file branch.
    generated.value.markExtracting(NOW);
    const { uc } = ingest({ book: generated.value });
    const result = await uc.execute({ referenceBookId: ID });
    if (!result.isFail()) throw new Error('expected a failure');
    expect(result.error).toMatch(/no uploaded file/);
  });
});

function start(signed: Result<{ url: string; token: string }> = Result.ok({ url: 'https://x', token: 't' })) {
  const saved: ReferenceBook[] = [];
  const references = { save: async (b: ReferenceBook) => void saved.push(b) } as unknown as ReferenceBookRepository;
  const storage = { signedUploadUrl: async () => signed } as unknown as ObjectStorage;
  return {
    uc: new StartReferenceUploadUseCase(references, storage, { uuid: () => ID }, { now: () => NOW }),
    saved,
  };
}

const upload = (over: Record<string, unknown> = {}) => ({
  ownerId: 'owner-1',
  title: 'The Sourdough Book',
  filename: 'book.pdf',
  contentType: PDF,
  byteSize: 5_000_000,
  ...over,
});

describe('StartReferenceUploadUseCase', () => {
  it('creates a pending reference and hands back an upload URL', async () => {
    const { uc, saved } = start();
    const result = await uc.execute(upload());
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.uploadUrl).toBe('https://x');
    expect(saved[0]!.status).toBe('PENDING');
  });

  // Filenames come from a browser. Nothing downstream needs the original.
  it('stores under the reference id, never the supplied filename', async () => {
    const { uc } = start();
    const result = await uc.execute(upload({ filename: '../../etc/passwd' }));
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.storagePath).toBe(`owner-1/${ID}.pdf`);
  });

  it('refuses a file type nothing can read', async () => {
    const { uc, saved } = start();
    const result = await uc.execute(upload({ contentType: 'image/png' }));
    expect(result.isFail()).toBe(true);
    expect(saved).toHaveLength(0);
  });

  it('refuses an empty or oversized file', async () => {
    const { uc } = start();
    expect((await uc.execute(upload({ byteSize: 0 }))).isFail()).toBe(true);
    expect((await uc.execute(upload({ byteSize: MAX_REFERENCE_BYTES + 1 }))).isFail()).toBe(true);
  });

  // No row without a URL to upload to — it would sit PENDING forever.
  it('creates nothing when storage cannot issue an upload URL', async () => {
    const { uc, saved } = start(Result.fail('storage down'));
    const result = await uc.execute(upload());
    expect(result.isFail()).toBe(true);
    expect(saved).toHaveLength(0);
  });
});
