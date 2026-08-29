import { describe, it, expect } from 'vitest';
import { ExportEbookUseCase } from './ExportEbookUseCase';
import { NonRetryableError } from '../errors';
import { Result } from '../../domain/shared/Result';
import { ExportFormat } from '../../domain/export/ExportArtifact';
import type { DocumentExporter, AssembledDocument, ExportedDocument } from '../ports/services/DocumentExporter';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { ExportArtifactRepository } from '../ports/repositories/ExportArtifactRepository';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const doc = { title: 'A Book' } as unknown as AssembledDocument;

/** Supabase Storage's verbatim rejection when an object is over the bucket limit. */
const OVERSIZED_ERROR = 'The object exceeded the maximum allowed size';

function exporter(byteLength: number): DocumentExporter {
  return {
    format: ExportFormat.PDF,
    export: async (): Promise<Result<ExportedDocument>> =>
      Result.ok({ bytes: new Uint8Array(byteLength), contentType: 'application/pdf', pageCount: 120 }),
  };
}

function storage(putResult: Result<{ path: string }>): ObjectStorage {
  return {
    put: async () => putResult,
    signedUploadUrl: async () => Result.ok({ url: '', token: '' }),
    signedUrl: async () => Result.ok(''),
    getDataUri: async () => Result.fail('unused'),
    getBytes: async () => Result.fail('unused'),
    exists: async () => true,
    remove: async () => Result.ok(),
  };
}

const artifacts: ExportArtifactRepository = {
  save: async () => {},
  listByProject: async () => [],
  findById: async () => null,
} as unknown as ExportArtifactRepository;

function run(bytes: number, put: Result<{ path: string }>) {
  const uc = new ExportEbookUseCase([exporter(bytes)], storage(put), artifacts);
  return uc.execute({ projectId: PROJECT_ID, doc, formats: [ExportFormat.PDF], bookVersion: 1 });
}

describe('ExportEbookUseCase', () => {
  it('stores a rendered artifact', async () => {
    const r = await run(1024, Result.ok({ path: 'p' }));
    expect(r.isOk()).toBe(true);
  });

  // Rendering is deterministic and takes ~35s of Chromium — three BullMQ attempts
  // reproduce the same rejection for two minutes of compute and tell the user
  // nothing. Stop on the first one.
  it('does not retry an artifact that is over the storage limit', async () => {
    await expect(run(12 * 1024 * 1024, Result.fail(OVERSIZED_ERROR))).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('names the actual size, which the storage error never does', async () => {
    const err = await run(12.5 * 1024 * 1024, Result.fail(OVERSIZED_ERROR)).then(
      () => null,
      (e: Error) => e,
    );
    if (!err) throw new Error('expected the export to throw');
    expect(err.message).toMatch(/12\.5MB/);
    expect(err.message).toMatch(/ebook-exports/);
  });

  // Only the size rejection is hopeless. A network blip should still retry.
  it('keeps other storage failures retryable', async () => {
    const r = await run(1024, Result.fail('upstream connect error'));
    expect(r.isFail()).toBe(true);
  });
});
