import type { SupabaseClient } from '@supabase/supabase-js';
import { Channel, ChannelSummary, VideoSummary, ProjectId, type ChannelRepository } from '@ebook/core';
import { reviveVideoKnowledge } from './mappers/videoKnowledge';

export class SupabaseChannelRepository implements ChannelRepository {
  constructor(private readonly db: SupabaseClient) {}

  async saveChannel(projectId: ProjectId, channel: Channel): Promise<void> {
    const { error } = await this.db.from('channels').upsert(
      {
        project_id: projectId.value,
        youtube_id: channel.youtubeId,
        title: channel.title,
        description: channel.description,
        subscriber_count: channel.subscriberCount,
      },
      { onConflict: 'project_id' },
    );
    if (error) throw new Error(error.message);
  }

  async getChannel(projectId: ProjectId): Promise<Channel | null> {
    const { data } = await this.db.from('channels').select('*').eq('project_id', projectId.value).maybeSingle();
    if (!data) return null;
    return Channel.create({
      youtubeId: data.youtube_id,
      title: data.title,
      description: data.description,
      subscriberCount: data.subscriber_count,
      videoCount: data.video_count,
      thumbnailUrl: data.thumbnail_url,
    });
  }

  async saveSummary(projectId: ProjectId, summary: ChannelSummary): Promise<void> {
    const { error } = await this.db.from('channel_summaries').upsert(
      {
        project_id: projectId.value,
        summary: summary.summary,
        topics: summary.topics,
        tone: summary.tone,
        input_hash: summary.inputHash,
      },
      { onConflict: 'project_id' },
    );
    if (error) throw new Error(error.message);
  }

  async getSummary(projectId: ProjectId): Promise<ChannelSummary | null> {
    const { data } = await this.db.from('channel_summaries').select('*').eq('project_id', projectId.value).maybeSingle();
    if (!data) return null;
    return ChannelSummary.create({
      summary: data.summary,
      topics: data.topics ?? [],
      audience: data.audience ?? '',
      tone: data.tone ?? '',
      inputHash: data.input_hash,
    });
  }

  async listVideoSummaries(projectId: ProjectId): Promise<VideoSummary[]> {
    const { data, error } = await this.db
      .from('video_summaries')
      .select('*, videos!inner(project_id)')
      .eq('videos.project_id', projectId.value);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => VideoSummary.create(reviveVideoKnowledge(r)));
  }
}
