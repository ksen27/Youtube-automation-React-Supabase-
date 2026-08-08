import { Result } from '../../domain/shared/Result';
import { ExportArtifact, ExportFormat } from '../../domain/export/ExportArtifact';
import type { DocumentExporter, AssembledDocument } from '../ports/services/DocumentExporter';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { ExportArtifactRepository } from '../ports/repositories/ExportArtifactRepository';

/** Storage bucket holding rendered ebook artifacts (private; served via signed URLs). */
export const EXPORT_BUCKET = 'ebook-exports';

/** Renders the assembled document to the requested formats and stores artifacts. */
export class ExportEbookUseCase {
  constructor(
    private readonly exporters: DocumentExporter[], // [pdf, docx]
    private readonly storage: ObjectStorage,
    private readonly artifacts: ExportArtifactRepository,
  ) {}

  async execute(input: {
    projectId: string;
    doc: AssembledDocument;
    formats: ExportFormat[];
    bookVersion: number;
  }): Promise<Result<{ paths: string[] }>> {
    const paths: string[] = [];
    for (const format of input.formats) {
      const exporter = this.exporters.find((e) => e.format === format);
      if (!exporter) return Result.fail(`No exporter for format ${format}`);

      const rendered = await exporter.export(input.doc);
      if (rendered.isFail()) return Result.fail(rendered.error);

      const ext = format === ExportFormat.PDF ? 'pdf' : 'docx';
      const path = `${input.projectId}/v${input.bookVersion}/ebook.${ext}`;
      const put = await this.storage.put(EXPORT_BUCKET, path, rendered.value.bytes, rendered.value.contentType);
      if (put.isFail()) return Result.fail(put.error);

      await this.artifacts.save(
        ExportArtifact.create({
          projectId: input.projectId,
          format,
          storagePath: path,
          byteSize: rendered.value.bytes.byteLength,
          pageCount: rendered.value.pageCount,
          bookVersion: input.bookVersion,
        }),
      );
      paths.push(path);
    }
    return Result.ok({ paths });
  }
}
