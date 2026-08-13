import type { Video } from '../../../domain/video/Video';
import type { VideoId } from '../../../domain/video/VideoId';
import type { VideoSummary } from '../../../domain/video/VideoSummary';
import type { ProjectId } from '../../../domain/project/ProjectId';

/**
 * A summarized video, WITHOUT its transcript or comments — the read model for
 * keyword retrieval. Deliberately not a `Video`: a Video with those fields
 * silently empty would read as "this video has no transcript", which is a lie
 * the type shouldn't be able to tell.
 */
export interface SummarizedVideo {
  id: string;
  title: string;
  summary: VideoSummary;
}

export interface VideoRepository {
  findById(id: VideoId): Promise<Video | null>;
  /** The FULL aggregate for every video — transcripts and comments included. */
  findByProject(projectId: ProjectId): Promise<Video[]>;
  /**
   * Just the summarized videos, for retrieval/ranking.
   *
   * Exists because chapter-research ranked videos over `findByProject`, dragging
   * every transcript and comment in the channel across the wire to read two
   * fields — once per chapter, with chapters fanned out ~16-wide per book. On
   * concurrent books that reliably tripped Postgres's statement timeout.
   */
  findSummarizedByProject(projectId: ProjectId): Promise<SummarizedVideo[]>;
  /** Cheap count of a project's videos (fan-in convergence check). */
  countByProject(projectId: ProjectId): Promise<number>;
  /** Upsert keyed on (project_id, youtube_id) — safe to re-run. */
  save(video: Video): Promise<void>;
  saveMany(videos: Video[]): Promise<void>;
}
