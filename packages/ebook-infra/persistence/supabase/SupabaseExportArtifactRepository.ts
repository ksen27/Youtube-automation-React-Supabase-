import type { SupabaseClient } from '@supabase/supabase-js';
import { ExportArtifact, ProjectId, type ExportArtifactRepository } from '@ebook/core';

export class SupabaseExportArtifactRepository implements ExportArtifactRepository {
  constructor(private readonly db: SupabaseClient) {}

  async save(artifact: ExportArtifact): Promise<void> {
    const { error } = await this.db.from('export_artifacts').insert({
      project_id: (artifact as unknown as { props: { projectId: string } }).props.projectId,
      format: artifact.format,
      storage_path: artifact.storagePath,
      page_count: artifact.pageCount,
      byte_size: artifact.byteSize,
      book_version: artifact.bookVersion,
    });
    if (error) throw new Error(error.message);
  }

  /**
   * The highest export version recorded for a project (0 if none yet). Used to
   * derive the next version so each (re-)export lands at its own storage path —
   * avoiding stale-CDN reads on an overwritten object and letting the UI detect
   * when a fresh PDF is ready by watching for a higher version.
   */
  async latestVersion(projectId: ProjectId): Promise<number> {
    const { data } = await this.db
      .from('export_artifacts')
      .select('book_version')
      .eq('project_id', projectId.value)
      .order('book_version', { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.book_version as number | undefined) ?? 0;
  }

  async findById(id: string): Promise<{ projectId: string; storagePath: string; format: string } | null> {
    const { data } = await this.db.from('export_artifacts').select('*').eq('id', id).maybeSingle();
    if (!data) return null;
    return { projectId: data.project_id, storagePath: data.storage_path, format: data.format };
  }

  async listByProject(projectId: ProjectId): Promise<ExportArtifact[]> {
    const { data } = await this.db.from('export_artifacts').select('*').eq('project_id', projectId.value);
    return (data ?? []).map((r) =>
      ExportArtifact.create({
        projectId: r.project_id,
        format: r.format,
        storagePath: r.storage_path,
        byteSize: r.byte_size ?? 0,
        pageCount: r.page_count ?? 0,
        bookVersion: r.book_version ?? 1,
      }),
    );
  }
}
