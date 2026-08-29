import {
  Result,
  splitIntoSections,
  isSupportedReferenceType,
  type ExtractedSection,
  type ReferenceTextExtractor,
} from '@ebook/core';

/**
 * Reads PDF, DOCX, plain-text and Markdown reference books.
 *
 * WHY THE PARSERS ARE IMPORTED LAZILY, not at the top of this file: the DI
 * container constructs this extractor, and the Next.js app calls that container
 * on every page that touches ebook data. A top-level `import 'pdf-parse'` therefore
 * pulled a PDF engine — with its own worker files and runtime asset loading —
 * into the serverless bundle of pages that never parse anything, and a module
 * that fails to load there throws BEFORE any request handler runs, which is a
 * 500 no try/catch in the page can absorb.
 *
 * Deferring the import to the moment a file is actually parsed keeps the parsers
 * in the worker, where the parsing happens. `next.config.ts` also lists them in
 * serverExternalPackages so Next never tries to bundle them at all.
 *
 * WHAT THIS CANNOT DO, and why it fails loudly rather than quietly: a scanned
 * book is images of text, and no text extractor can read it — the parser returns
 * an empty string and reports success. Left alone that becomes a reference with
 * no words, which the domain's minimum-length check rejects with a message
 * naming the likely cause. Both layers matter: this one explains WHY nothing
 * came out, the domain one guarantees an empty reference can never be selected.
 */
export class FileTextExtractor implements ReferenceTextExtractor {
  async extract(bytes: Uint8Array, contentType: string): Promise<Result<ExtractedSection[]>> {
    if (!isSupportedReferenceType(contentType)) {
      return Result.fail(`Cannot read ${contentType || 'that file type'} — upload a PDF, DOCX, TXT or Markdown file`);
    }
    try {
      const text = await this.readText(bytes, contentType);
      const sections = splitIntoSections(text);
      if (sections.length === 0) {
        return Result.fail(
          'No text could be read from this file. If it is a scanned book, its pages are images rather ' +
            'than text and it cannot be used as a reference.',
        );
      }
      return Result.ok(sections);
    } catch (e) {
      // A password-protected or corrupt file throws from deep inside the parser.
      // The raw message is unhelpful to whoever uploaded it, so lead with what
      // they can act on and keep the cause behind it.
      const message = e instanceof Error ? e.message : String(e);
      return Result.fail(`Could not read this file — it may be corrupt or password-protected (${message})`);
    }
  }

  private async readText(bytes: Uint8Array, contentType: string): Promise<string> {
    if (contentType === 'application/pdf') {
      const { PDFParse } = await import('pdf-parse');
      // pdf-parse v2 is a class, and the instance holds an open document, so it
      // is destroyed rather than left to the GC — this runs on a long-lived
      // worker where a leaked document per upload accumulates.
      const parser = new PDFParse({ data: bytes });
      try {
        const result = await parser.getText();
        return result.text;
      } finally {
        await parser.destroy();
      }
    }
    if (contentType.endsWith('wordprocessingml.document')) {
      const mammoth = await import('mammoth');
      // Raw text, not HTML: the sectioner works on blank-line structure, and
      // mammoth's raw extraction preserves paragraph breaks as newlines.
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      return result.value;
    }
    return Buffer.from(bytes).toString('utf8');
  }
}
