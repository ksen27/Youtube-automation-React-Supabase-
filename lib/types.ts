// Shared domain types. Mirrors the Supabase schema in 0001_init.sql.

export type ProjectStatus =
  | "draft"
  | "extracting"
  | "searching"
  | "downloading"
  | "clipping"
  | "matching"
  | "ready_for_review"
  | "rendering"
  | "completed"
  | "failed";

export interface Project {
  id: string;
  user_id: string | null;
  title: string;
  transcript: string | null;
  voiceover_url: string | null;
  voiceover_duration_seconds: number | null;
  bg_music_url: string | null;
  bg_music_gain: number;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

export type EntityType =
  | "celebrity"
  | "related_person"
  | "movie"
  | "tv_show"
  | "song"
  | "company"
  | "place"
  | "event"
  | "year"
  | "age";

export interface ProjectEntity {
  id: string;
  project_id: string;
  type: EntityType | string;
  value: string;
  confidence: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface YoutubeSearchResult {
  id: string;
  project_id: string;
  youtube_video_id: string;
  url: string | null;
  title: string | null;
  description: string | null;
  channel_id: string | null;
  channel_title: string | null;
  duration_seconds: number | null;
  score: number;
  status: "candidate" | "selected" | "rejected" | "downloaded";
  metadata: Record<string, unknown>;
  created_at: string;
}

export type VideoSourceStatus =
  | "queued"
  | "downloading"
  | "downloaded"
  | "clipped"
  | "failed";

export interface VideoSource {
  id: string;
  project_id: string | null;
  youtube_video_id: string;
  youtube_url: string | null;
  title: string | null;
  channel_title: string | null;
  duration_seconds: number | null;
  local_path: string | null;
  storage_url: string | null;
  status: VideoSourceStatus;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type VideoClipStatus = "pending" | "ready" | "failed";

export interface VideoClip {
  id: string;
  project_id: string;
  video_source_id: string;
  start_time: number;
  end_time: number;
  duration: number;
  clip_url: string | null;
  thumbnail_url: string | null;
  relevance_score: number;
  labels: string[];
  status: VideoClipStatus;
  created_at: string;
}

export type TimelineItemType =
  | "intro"
  | "footage"
  | "image"
  | "split_2"
  | "split_4"
  | "lower_third"
  | "transition";

export interface TimelineItem {
  id: string;
  project_id: string;
  clip_id: string | null;
  type: TimelineItemType;
  position: number;
  start_time: number | null;
  duration: number;
  script_text: string | null;
  overlay_text: string | null;
  metadata: Record<string, unknown>;
  approved: boolean;
  created_at: string;
}

export type RenderStatus = "queued" | "running" | "completed" | "failed";

export interface RenderJob {
  id: string;
  project_id: string;
  status: RenderStatus;
  progress: number;
  output_url: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type MediaJobType =
  | "analyze"
  | "search"
  | "download"
  | "clip"
  | "match"
  | "render";
export type MediaJobStatus = "queued" | "running" | "completed" | "failed";

export interface MediaJob {
  id: string;
  project_id: string;
  type: MediaJobType;
  status: MediaJobStatus;
  progress: number;
  attempts: number;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
