import { Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun, AlignmentType } from 'docx';
import { Result, ExportFormat, parseRecipe, type Recipe, type DocumentExporter, type AssembledDocument, type ExportedDocument } from '@ebook/core';

/** Renders the assembled document to a .docx using the `docx` library. */
export class DocxExporter implements DocumentExporter {
  readonly format = ExportFormat.DOCX;

  async export(doc: AssembledDocument): Promise<Result<ExportedDocument>> {
    try {
      const children: Paragraph[] = [];

      // Cover art (when generated) on its own page. doc.coverImage is a base64
      // data URI; the docx library embeds from raw bytes, so decode it first.
      const cover = doc.coverImage ? decodeImageDataUri(doc.coverImage) : null;
      if (cover) {
        children.push(
          new Paragraph({
            children: [new ImageRun({ data: cover.bytes, type: cover.type, transformation: { width: 600, height: 900 } })],
          }),
        );
      }

      children.push(
        new Paragraph({ text: doc.title, heading: HeadingLevel.TITLE, ...(cover ? { pageBreakBefore: true } : {}) }),
        ...(doc.subtitle ? [new Paragraph({ children: [new TextRun({ text: doc.subtitle })] })] : []),
        new Paragraph({ children: [new TextRun({ text: doc.author, italics: true })] }),
      );

      // Front matter (introduction, foreword).
      for (const m of doc.frontMatter) {
        children.push(new Paragraph({ text: m.title, heading: HeadingLevel.HEADING_1, pageBreakBefore: true }));
        children.push(...toParagraphs(m.content));
      }

      // Table of contents.
      if (doc.tableOfContents.length) {
        children.push(new Paragraph({ text: 'Contents', heading: HeadingLevel.HEADING_1, pageBreakBefore: true }));
        doc.tableOfContents.forEach((t, i) => children.push(new Paragraph({ children: [new TextRun(`${i + 1}. ${t}`)] })));
      }

      for (const chapter of doc.chapters) {
        // Cooking books store a structured recipe as JSON — render it as readable
        // recipe text rather than dumping the raw JSON into the document.
        const recipe = doc.bookType === 'cooking' ? parseRecipe(chapter.content) : null;
        if (recipe) {
          children.push(...recipeParagraphs(recipe, chapter.illustrations));
          continue;
        }
        children.push(new Paragraph({ text: chapter.title, heading: HeadingLevel.HEADING_1, pageBreakBefore: true }));
        children.push(...withIllustrations(toParagraphs(chapter.content), chapter.illustrations));
        for (const section of chapter.sections) {
          children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_2 }));
          children.push(...toParagraphs(section.content));
        }
      }

      // Back matter (conclusion, FAQ, resources, glossary, bonus chapter, about).
      for (const m of doc.backMatter) {
        children.push(new Paragraph({ text: m.title, heading: HeadingLevel.HEADING_1, pageBreakBefore: true }));
        children.push(...toParagraphs(m.content));
      }

      const document = new Document({ sections: [{ children }] });
      const buffer = await Packer.toBuffer(document);
      // ~3 paragraphs/inch is a rough heuristic; real count comes from the PDF render.
      const pageCount = Math.max(1, Math.ceil(children.length / 30));
      return Result.ok({
        bytes: new Uint8Array(buffer),
        pageCount,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    } catch (e) {
      return Result.fail(e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * Spread a chapter's illustrations evenly across its paragraphs — each image
 * inserted after an interior paragraph at position (k+1)/(M+1), mirroring the PDF.
 */
function withIllustrations(
  paragraphs: Paragraph[],
  illustrations?: Array<{ dataUri: string; alt: string }>,
): Paragraph[] {
  const figs = illustrations ?? [];
  if (figs.length === 0 || paragraphs.length === 0) return paragraphs;

  const decoded = figs
    .map((f) => decodeImageDataUri(f.dataUri))
    .filter((d): d is { bytes: Buffer; type: 'png' | 'jpg' | 'gif' | 'bmp' } => d !== null);
  if (decoded.length === 0) return paragraphs;

  const positions = decoded.map((_, k) =>
    Math.min(paragraphs.length, Math.max(1, Math.round(((k + 1) / (decoded.length + 1)) * paragraphs.length))),
  );
  const out: Paragraph[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    out.push(paragraphs[i]!);
    decoded.forEach((img, k) => {
      if (positions[k] === i + 1) {
        out.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            // Partial-page inset (~4.7"×3.1"), centered and flowing with the text — not a full page.
            children: [new ImageRun({ data: img.bytes, type: img.type, transformation: { width: 450, height: 300 } })],
          }),
        );
      }
    });
  }
  return out;
}

/** Decode a `data:image/...;base64,...` URI into the bytes + type the docx ImageRun needs. */
function decodeImageDataUri(uri: string): { bytes: Buffer; type: 'png' | 'jpg' | 'gif' | 'bmp' } | null {
  const m = /^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/i.exec(uri);
  if (!m) return null;
  const ext = m[1]!.toLowerCase();
  const type = ext === 'jpeg' || ext === 'jpg' ? 'jpg' : (ext as 'png' | 'gif' | 'bmp');
  return { bytes: Buffer.from(m[2]!, 'base64'), type };
}

/** Render one recipe as a readable sequence of DOCX paragraphs (title, photo, meta, ingredients, steps, tips). */
function recipeParagraphs(r: Recipe, illustrations?: Array<{ dataUri: string; alt: string }>): Paragraph[] {
  const out: Paragraph[] = [];
  out.push(new Paragraph({ text: r.title, heading: HeadingLevel.HEADING_1, pageBreakBefore: true }));

  const photo = illustrations?.[0] ? decodeImageDataUri(illustrations[0].dataUri) : null;
  if (photo) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({ data: photo.bytes, type: photo.type, transformation: { width: 500, height: 300 } })],
      }),
    );
  }

  if (r.description) out.push(new Paragraph({ children: [new TextRun({ text: r.description, italics: true })] }));
  out.push(
    new Paragraph({
      children: [
        new TextRun({ text: `Servings: ${r.servings}   Prep: ${r.prepTimeMinutes} min   Cook: ${r.cookTimeMinutes} min`, bold: true }),
      ],
    }),
  );

  out.push(new Paragraph({ text: 'Ingredients', heading: HeadingLevel.HEADING_2 }));
  for (const ing of r.ingredients) out.push(new Paragraph({ text: ing, bullet: { level: 0 } }));

  out.push(new Paragraph({ text: 'Instructions', heading: HeadingLevel.HEADING_2 }));
  r.instructions.forEach((s, i) =>
    out.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${i + 1}. ` }),
          ...(s.label ? [new TextRun({ text: `${s.label}: `, bold: true })] : []),
          new TextRun({ text: s.text }),
        ],
      }),
    ),
  );

  if (r.tips.length) {
    out.push(new Paragraph({ text: 'Tips and Variations', heading: HeadingLevel.HEADING_2 }));
    for (const tip of r.tips) out.push(new Paragraph({ children: [new TextRun({ text: tip, italics: true })] }));
  }
  return out;
}

function toParagraphs(markdown: string): Paragraph[] {
  return markdown
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      if (block.startsWith('## ')) return new Paragraph({ text: block.slice(3), heading: HeadingLevel.HEADING_2 });
      if (block.startsWith('### ')) return new Paragraph({ text: block.slice(4), heading: HeadingLevel.HEADING_3 });
      return new Paragraph({ children: [new TextRun(block.replace(/[*#]/g, ''))] });
    });
}
