import type { Result } from '../../../domain/shared/Result';
import type { ExportFormat } from '../../../domain/export/ExportArtifact';

export interface AssembledDocument {
  /** Book kind — the exporter uses this to pick the prose vs. recipe-card layout. */
  bookType: 'normal' | 'cooking';
  title: string;
  subtitle: string;
  /** Optional cover promise/benefit line (the book's core promise). */
  promise?: string;
  /** Optional URL of the AI-generated cover illustration, rendered full-bleed behind the cover text. */
  coverImage?: string;
  author: string;
  copyright: string;
  /** Front-matter table of contents (chapter titles in order). */
  tableOfContents: string[];
  /** Front matter (introduction, foreword) rendered before the chapters. */
  frontMatter: Array<{ title: string; content: string }>;
  chapters: Array<{
    title: string;
    content: string; // markdown
    sections: Array<{ title: string; content: string }>;
    /**
     * In-chapter illustrations as base64 data URIs, in order. The renderer spreads
     * them evenly across the chapter's paragraphs. Inlined (not URLs) for the same
     * reason as the cover — Paged.js drops network images after re-chunking.
     */
    illustrations?: Array<{ dataUri: string; alt: string }>;
  }>;
  /** Optional back-matter (conclusion, resources, glossary, about author). */
  backMatter: Array<{ title: string; content: string }>;
}

export interface ExportedDocument {
  bytes: Uint8Array;
  pageCount: number;
  contentType: string;
}

/** PDF (Puppeteer) and DOCX exporters implement this. */
export interface DocumentExporter {
  readonly format: ExportFormat;
  export(doc: AssembledDocument): Promise<Result<ExportedDocument>>;
}
