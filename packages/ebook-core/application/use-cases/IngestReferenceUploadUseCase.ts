import { Result } from '../../domain/shared/Result';
import { ReferenceBookId } from '../../domain/reference/ReferenceBookId';
import { ReferenceSection } from '../../domain/reference/ReferenceSection';
import type { ReferenceBookRepository } from '../ports/repositories/ReferenceBookRepository';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { ReferenceTextExtractor } from '../ports/services/ReferenceTextExtractor';
import type { JobQueue } from '../ports/services/JobQueue';
import type { Clock } from '../ports/Clock';
import type { ReferenceJob } from '../dto/jobs.dto';
import { REFERENCE_BUCKET } from './StartReferenceUploadUseCase';

export type IngestOutcome = 'ingested' | 'already-ingested';

/**
 * Step two of an upload: read the uploaded file and turn it into sections.
 *
 * A job rather than part of the request that finishes the upload, because
 * parsing a 300-page PDF is seconds of CPU — long enough to time out a
 * serverless handler and long enough that the user should not be watching a
 * spinner for it.
 *
 * Every failure is recorded ON the reference rather than only thrown. A
 * reference that cannot be read is a permanent, user-visible fact about that
 * file — "this is a scanned book" is something the picker must be able to show
 * — and a thrown error alone would leave the row stuck in PENDING with no
 * explanation and no way to tell it apart from one still being processed.
 */
export class IngestReferenceUploadUseCase {
  constructor(
    private readonly references: ReferenceBookRepository,
    private readonly storage: ObjectStorage,
    private readonly extractor: ReferenceTextExtractor,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
  ) {}

  async execute(cmd: ReferenceJob): Promise<Result<{ outcome: IngestOutcome; sections: number }>> {
    const id = ReferenceBookId.from(cmd.referenceBookId);
    const reference = await this.references.findById(id);
    if (!reference) return Result.fail('Reference book not found');
    // Idempotent: BullMQ can deliver a job twice, and re-parsing a book that
    // already has its text would replace good sections with identical ones at
    // the cost of another full parse.
    if (reference.status === 'DONE' && reference.sections.length > 0) {
      return Result.ok({ outcome: 'already-ingested', sections: reference.sections.length });
    }
    if (!reference.storagePath || !reference.contentType) {
      return Result.fail('This reference has no uploaded file to read');
    }

    reference.markExtracting(this.clock.now());
    await this.references.save(reference);

    const bytes = await this.storage.getBytes(REFERENCE_BUCKET, reference.storagePath);
    if (bytes.isFail()) {
      // The row exists but the file does not: the browser upload never completed.
      // Recorded rather than retried, because no amount of retrying uploads it.
      reference.markFailed(`The uploaded file could not be read back from storage (${bytes.error})`, this.clock.now());
      await this.references.save(reference);
      return Result.fail(bytes.error);
    }

    const extracted = await this.extractor.extract(bytes.value.bytes, reference.contentType);
    if (extracted.isFail()) {
      reference.markFailed(extracted.error, this.clock.now());
      await this.references.save(reference);
      return Result.fail(extracted.error);
    }

    const sections = extracted.value.map((s, index) =>
      ReferenceSection.create({ position: index, title: s.title, content: s.content }),
    );
    // attachSections enforces the minimum length and marks the reference FAILED
    // with a diagnosis when the text is too thin — the scanned-PDF case.
    const attached = reference.attachSections(sections, this.clock.now());
    await this.references.save(reference);
    if (attached.isFail()) return Result.fail(attached.error);

    // Text first, then voice. The reference is already usable as material; the
    // style profile follows in its own job.
    await this.queue.enqueue(
      'reference-extract',
      { referenceBookId: cmd.referenceBookId },
      { jobId: `reference-extract:${cmd.referenceBookId}` },
    );
    return Result.ok({ outcome: 'ingested', sections: sections.length });
  }
}
