import { describe, expect, it } from 'vitest';
import { ReferenceBook } from '../../domain/reference/ReferenceBook';
import { ReferenceBookId } from '../../domain/reference/ReferenceBookId';
import { ReferenceSection } from '../../domain/reference/ReferenceSection';
import { ReferenceStyleProfile } from '../../domain/reference/ReferenceStyleProfile';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { ReferenceBookRepository } from '../ports/repositories/ReferenceBookRepository';
import type { JobQueue } from '../ports/services/JobQueue';
import { SubmitBookUseCase } from './SubmitBookUseCase';

const NOW = new Date('2026-08-29T00:00:00Z');
const OWNER = 'owner-1';
const REF_ID = '11111111-1111-4111-8111-111111111111';

function profile(detectedKind: 'normal' | 'cooking' | 'other'): ReferenceStyleProfile {
  return ReferenceStyleProfile.create({
    voice: 'v',
    readerAddress: 'r',
    chapterShape: 'c',
    openingMove: 'o',
    closingMove: 'c',
    pacing: 'p',
    vocabulary: 'v',
    recurringDevices: [],
    avoid: [],
    detectedKind,
    inputHash: 'h',
  });
}

function reference(options: { usable?: boolean; kind?: 'normal' | 'cooking'; ownerId?: string } = {}) {
  const sections = [
    ReferenceSection.create({ position: 0, title: 'One', content: Array(2500).fill('prose').join(' ') }),
  ];
  const r = ReferenceBook.fromGeneratedBook({
    id: ReferenceBookId.from(REF_ID),
    ownerId: options.ownerId ?? OWNER,
    title: 'Car Care Basics',
    originProjectId: '22222222-2222-4222-8222-222222222222',
    sections,
    now: NOW,
  });
  if (r.isFail()) throw new Error(r.error);
  if (options.usable === false) r.value.markFailed('extraction failed', NOW);
  if (options.kind) r.value.attachStyleProfile(profile(options.kind));
  return r.value;
}

function useCase(ref: ReferenceBook | null) {
  const enqueued: Array<{ queue: string; payload: unknown }> = [];
  const attached: string[][] = [];
  const saved: unknown[] = [];
  const projects = {
    countRunningByOwner: async () => 0,
    listQueuedByOwner: async () => [],
    save: async (p: unknown) => void saved.push(p),
  } as unknown as ProjectRepository;
  const references = {
    findById: async () => ref,
    attachToProject: async (_p: unknown, ids: Array<{ value: string }>) =>
      void attached.push(ids.map((i) => i.value)),
  } as unknown as ReferenceBookRepository;
  const queue = {
    enqueue: async (q: string, payload: unknown) => void enqueued.push({ queue: q, payload }),
  } as unknown as JobQueue;
  const uc = new SubmitBookUseCase(
    projects,
    references,
    queue,
    { uuid: () => '33333333-3333-4333-8333-333333333333' },
    { now: () => NOW },
    3,
  );
  return { uc, enqueued, attached, saved };
}

const dto = (overrides: Record<string, unknown> = {}) => ({
  referenceBookIds: [REF_ID],
  options: {
    bookTitle: 'Sourdough for Beginners',
    bookType: 'normal' as const,
    targetPages: 100,
    recipeCount: 60,
    tone: 'professional' as const,
    includeIllustrations: true,
    illustrationEveryPages: 5,
    landingPage: false,
    landingCurrency: 'USD',
    landingGuaranteeDays: 30,
    landingMode: 'single' as const,
    landingSiblings: [],
    ...overrides,
  },
});

describe('SubmitBookUseCase', () => {
  it('creates the project, attaches the reference and starts the brief', async () => {
    const { uc, enqueued, attached } = useCase(reference());
    const result = await uc.execute(OWNER, dto() as never);
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.status).toBe('GENERATING_BOOK_BRIEF');
    expect(result.value.queued).toBe(false);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.queue).toBe('book-brief');
    expect(attached[0]).toEqual([REF_ID]);
  });

  // The title is the only source of subject, so this has to fail at submit —
  // there is no later stage that would notice.
  it('refuses a title that names a format but no subject', async () => {
    const { uc, enqueued } = useCase(reference());
    const result = await uc.execute(OWNER, dto({ bookTitle: 'My Complete Guide' }) as never);
    expect(result.isFail()).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  it('refuses a reference whose text is not extracted yet', async () => {
    const { uc, enqueued } = useCase(reference({ usable: false }));
    const result = await uc.execute(OWNER, dto() as never);
    if (!result.isFail()) throw new Error('expected a failure');
    expect(result.error).toMatch(/not ready to be used as a reference/);
    expect(enqueued).toHaveLength(0);
  });

  it('refuses a reference that does not exist', async () => {
    const { uc } = useCase(null);
    const result = await uc.execute(OWNER, dto() as never);
    expect(result.isFail()).toBe(true);
  });

  // Someone else's reference gets the same answer as a missing one: whether it
  // exists is not this caller's business.
  it('hides another owner behind the same not-found message', async () => {
    const { uc } = useCase(reference({ ownerId: 'someone-else' }));
    const result = await uc.execute(OWNER, dto() as never);
    if (!result.isFail()) throw new Error('expected a failure');
    expect(result.error).toMatch(/was not found/);
  });

  it('warns, but still starts, when the reference is a different kind of book', async () => {
    const { uc, enqueued } = useCase(reference({ kind: 'cooking' }));
    const result = await uc.execute(OWNER, dto() as never);
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.referenceTypeMismatch).toMatch(/cooking book, but this is a normal book/);
    expect(enqueued).toHaveLength(1); // advisory, not a rejection
  });

  it('does not warn when the reference matches the book type', async () => {
    const { uc } = useCase(reference({ kind: 'normal' }));
    const result = await uc.execute(OWNER, dto() as never);
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.referenceTypeMismatch).toBeUndefined();
  });

  it('parks the book in QUEUED when the owner is at the concurrency cap', async () => {
    const { uc, enqueued, attached } = useCase(reference());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (uc as any).projects.countRunningByOwner = async () => 3;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (uc as any).projects.listQueuedByOwner = async () => [{}, {}];
    const result = await uc.execute(OWNER, dto() as never);
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.status).toBe('QUEUED');
    expect(result.value.queuePosition).toBe(3);
    // Nothing is enqueued — the admission controller starts it later — but the
    // references are attached now, or the brief would have no voice to use.
    expect(enqueued).toHaveLength(0);
    expect(attached[0]).toEqual([REF_ID]);
  });
});
