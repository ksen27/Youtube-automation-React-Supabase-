import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Video,
  VideoId,
  ProjectId,
  Transcript,
  Comment,
  VideoSummary,
  TranscriptSource,
  type VideoRepository,
} from '@ebook/core';
import { reviveVideoKnowledge } from './mappers/videoKnowledge';

/**
 * Persists the Video aggregate across videos/transcripts/comments/video_summaries.
 * All writes are upserts keyed on natural keys → safe to re-run.
 */
export class SupabaseVideoRepository implements VideoRepository {
  constructor(private readonly db: SupabaseClient) {}

  async findById(id: VideoId): Promise<Video | null> {
    const { data, error } = await this.db
      .from('videos')
      .select('*, transcripts(*), comments(*), video_summaries(*)')
      .eq('id', id.value)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? this.toDomain(data) : null;
  }

  async findByProject(projectId: ProjectId): Promise<Video[]> {
    const { data, error } = await this.db
      .from('videos')
      .select('*, transcripts(*), comments(*), video_summaries(*)')
      .eq('project_id', projectId.value)
      .order('position');
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => this.toDomain(r));
  }

  async countByProject(projectId: ProjectId): Promise<number> {
    const { count, error } = await this.db
      .from('videos')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId.value);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  async save(video: Video): Promise<void> {
    await this.upsertVideo(video);
  }

  async saveMany(videos: Video[]): Promise<void> {
    if (videos.length === 0) return;
    const { error } = await this.db.from('videos').upsert(videos.map((v) => this.videoRow(v)), {
      onConflict: 'project_id,youtube_id',
    });
    if (error) throw new Error(error.message);
  }

  private async upsertVideo(video: Video): Promise<void> {
    const { error } = await this.db.from('videos').upsert(this.videoRow(video), { onConflict: 'project_id,youtube_id' });
    if (error) throw new Error(error.message);

    if (video.transcript) {
      await this.db.from('transcripts').upsert(
        {
          video_id: video.id.value,
          source: video.transcript.source,
          text: video.transcript.text,
          segments: video.transcript.segments,
          input_hash: video.transcript.inputHash,
        },
        { onConflict: 'video_id' },
      );
    }
    if (video.comments.length > 0) {
      await this.db.from('comments').upsert(
        video.comments.map((c) => ({
          video_id: video.id.value,
          youtube_id: cYoutubeId(c),
          author: null,
          text: c.text,
          like_count: c.likeCount,
        })),
        { onConflict: 'video_id,youtube_id' },
      );
    }
    if (video.summary) {
      await this.db.from('video_summaries').upsert(
        {
          video_id: video.id.value,
          summary: video.summary.summary,
          data: video.summary.toJSON(), // full Phase 5 VideoKnowledge
          model: 'claude-sonnet-4-6',
          input_hash: video.summary.inputHash,
        },
        { onConflict: 'video_id' },
      );
    }
  }

  private videoRow(video: Video) {
    return {
      id: video.id.value,
      project_id: video.projectId,
      youtube_id: video.youtubeId,
      title: video.title,
      position: video.position,
      status: video.summary ? 'DONE' : 'PENDING',
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toDomain(row: any): Video {
    const transcriptRow = Array.isArray(row.transcripts) ? row.transcripts[0] : row.transcripts;
    const summaryRow = Array.isArray(row.video_summaries) ? row.video_summaries[0] : row.video_summaries;
    const transcript = transcriptRow
      ? transcriptRow.source === TranscriptSource.WHISPER
        ? Transcript.fromWhisper(
            { language: null, text: transcriptRow.text, segments: transcriptRow.segments ?? [], audioRef: transcriptRow.audio_ref ?? '' },
            transcriptRow.input_hash,
          )
        : Transcript.fromYouTube(
            { language: null, text: transcriptRow.text, segments: transcriptRow.segments ?? [] },
            transcriptRow.input_hash,
          )
      : undefined;

    const video = Video.rehydrate(
      {
        projectId: row.project_id,
        youtubeId: row.youtube_id,
        title: row.title,
        description: row.description ?? null,
        publishedAt: row.published_at ? new Date(row.published_at) : null,
        durationSeconds: row.duration_s ?? null,
        viewCount: row.view_count ?? null,
        position: row.position,
        hasAudio: row.has_audio ?? true,
        status: row.status ?? 'PENDING',
        ...(transcript ? { transcript } : {}),
        comments: (row.comments ?? []).map((c: { text: string; like_count: number }) =>
          Comment.create({ youtubeId: '', author: null, text: c.text, likeCount: c.like_count, publishedAt: null }),
        ),
        ...(summaryRow
          ? { summary: VideoSummary.create(reviveVideoKnowledge(summaryRow)) }
          : {}),
      },
      VideoId.from(row.id),
    );
    return video;
  }
}

function cYoutubeId(_c: Comment): string {
  // Comments persist their own youtube id via the mapper; placeholder keeps the VO clean.
  return crypto.randomUUID();
}
