import { Result } from '../../domain/shared/Result';
import { ReferenceBook } from '../../domain/reference/ReferenceBook';
import { ReferenceBookId } from '../../domain/reference/ReferenceBookId';
import type { ReferenceBookRepository } from '../ports/repositories/ReferenceBookRepository';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { IdGenerator } from '../ports/IdGenerator';
import type { Clock } from '../ports/Clock';
import { isSupportedReferenceType } from '../ports/services/ReferenceTextExtractor';

/** Private bucket holding uploaded reference files. */
export const REFERENCE_BUCKET = 'ebook-references';

/**
 * A whole book. Generous, because the cost of rejecting a legitimate 60MB
 * illustrated cookbook is worse than the cost of storing one.
 */
export const MAX_REFERENCE_BYTES = 100 * 1024 * 1024;

export interface StartReferenceUploadResult {
  referenceBookId: string;
  /** The URL the browser PUTs the file to. */
  uploadUrl: string;
  /** Supabase's upload token, which its client requires alongside the URL. */
  token: string;
  storagePath: string;
}

/**
 * Step one of an upload: create the reference row and hand back a URL the
 * BROWSER uploads to directly.
 *
 * The bytes never pass through the app. A reference book is a whole book —
 * routinely tens of megabytes — and a serverless route caps request bodies
 * around 4.5MB, so routing the file through an API handler would fail for
 * exactly the files this feature exists to accept.
 *
 * The row is created BEFORE the upload, in PENDING: it is what the caller
 * confirms against in step two, and a row with no file is visibly stuck rather
 * than silently absent. See IngestReferenceUploadUseCase for the other half.
 */
export class StartReferenceUploadUseCase {
  constructor(
    private readonly references: ReferenceBookRepository,
    private readonly storage: ObjectStorage,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    ownerId: string;
    title: string;
    filename: string;
    contentType: string;
    byteSize: number;
  }): Promise<Result<StartReferenceUploadResult>> {
    if (input.title.trim().length === 0) return Result.fail('Give the reference book a title');
    if (!isSupportedReferenceType(input.contentType)) {
      return Result.fail(
        `Cannot read ${input.contentType || 'that file type'} — upload a PDF, DOCX, TXT or Markdown file`,
      );
    }
    if (input.byteSize <= 0) return Result.fail('That file is empty');
    if (input.byteSize > MAX_REFERENCE_BYTES) {
      return Result.fail(`That file is larger than ${Math.floor(MAX_REFERENCE_BYTES / 1024 / 1024)}MB`);
    }

    const id = ReferenceBookId.from(this.ids.uuid());
    // The stored name is the reference id, not the user's filename: filenames
    // arrive from a browser and are attacker-controlled, and nothing downstream
    // needs the original name.
    const extension = extensionFor(input.contentType);
    const storagePath = `${input.ownerId}/${id.value}.${extension}`;

    const signed = await this.storage.signedUploadUrl(REFERENCE_BUCKET, storagePath);
    if (signed.isFail()) return Result.fail(signed.error);

    const reference = ReferenceBook.uploaded({
      id,
      ownerId: input.ownerId,
      title: input.title,
      storagePath,
      contentType: input.contentType,
      byteSize: input.byteSize,
      now: this.clock.now(),
    });
    if (reference.isFail()) return Result.fail(reference.error);
    await this.references.save(reference.value);

    return Result.ok({
      referenceBookId: id.value,
      uploadUrl: signed.value.url,
      token: signed.value.token,
      storagePath,
    });
  }
}

function extensionFor(contentType: string): string {
  if (contentType === 'application/pdf') return 'pdf';
  if (contentType.endsWith('wordprocessingml.document')) return 'docx';
  if (contentType === 'text/markdown') return 'md';
  return 'txt';
}
