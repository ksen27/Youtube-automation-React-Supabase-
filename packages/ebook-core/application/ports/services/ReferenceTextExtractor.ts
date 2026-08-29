import type { Result } from '../../../domain/shared/Result';
import type { ExtractedSection } from '../../../domain/reference/sectionText';

/** File types a reference can be uploaded as. */
export const SUPPORTED_REFERENCE_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'text/plain',
  'text/markdown',
] as const;

export type SupportedReferenceType = (typeof SUPPORTED_REFERENCE_TYPES)[number];

export function isSupportedReferenceType(contentType: string): contentType is SupportedReferenceType {
  return (SUPPORTED_REFERENCE_TYPES as readonly string[]).includes(contentType);
}

/**
 * Reads an uploaded book file and returns its text, already split into
 * retrievable sections.
 *
 * A port rather than a direct call because the parsers are heavy, native-ish
 * dependencies: keeping them behind this interface is what lets the use case be
 * tested without a real PDF, and what will let the PDF parser be swapped when a
 * better one appears — which, for PDF text extraction, it periodically does.
 */
export interface ReferenceTextExtractor {
  extract(bytes: Uint8Array, contentType: string): Promise<Result<ExtractedSection[]>>;
}
