import { ValueObject } from '../shared/ValueObject';

export const ExportFormat = { PDF: 'pdf', DOCX: 'docx' } as const;
export type ExportFormat = (typeof ExportFormat)[keyof typeof ExportFormat];

interface ExportArtifactProps {
  projectId: string;
  format: ExportFormat;
  storagePath: string;
  byteSize: number;
  pageCount: number;
  bookVersion: number;
}

export class ExportArtifact extends ValueObject<ExportArtifactProps> {
  static create(props: ExportArtifactProps): ExportArtifact {
    return new ExportArtifact(props);
  }
  get format() {
    return this.props.format;
  }
  get storagePath() {
    return this.props.storagePath;
  }
  get pageCount() {
    return this.props.pageCount;
  }
  get byteSize() {
    return this.props.byteSize;
  }
  get bookVersion() {
    return this.props.bookVersion;
  }
}
