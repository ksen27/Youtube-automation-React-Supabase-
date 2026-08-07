import type { Video } from '../../../domain/video/Video';
import type { VideoId } from '../../../domain/video/VideoId';
import type { ProjectId } from '../../../domain/project/ProjectId';

export interface VideoRepository {
  findById(id: VideoId): Promise<Video | null>;
  findByProject(projectId: ProjectId): Promise<Video[]>;
  /** Cheap count of a project's videos (fan-in convergence check). */
  countByProject(projectId: ProjectId): Promise<number>;
  /** Upsert keyed on (project_id, youtube_id) — safe to re-run. */
  save(video: Video): Promise<void>;
  saveMany(videos: Video[]): Promise<void>;
}
