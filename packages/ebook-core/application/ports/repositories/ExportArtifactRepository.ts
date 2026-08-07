import type { ExportArtifact } from '../../../domain/export/ExportArtifact';
import type { ProjectId } from '../../../domain/project/ProjectId';

export interface ExportArtifactRepository {
  save(artifact: ExportArtifact): Promise<void>;
  findById(id: string): Promise<{ projectId: string; storagePath: string; format: string } | null>;
  listByProject(projectId: ProjectId): Promise<ExportArtifact[]>;
  /** Highest `bookVersion` recorded for the project, or 0 when none exists yet. */
  latestVersion(projectId: ProjectId): Promise<number>;
}
