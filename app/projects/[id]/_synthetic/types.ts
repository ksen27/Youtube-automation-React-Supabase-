// Shared client types for the synthetic-engine screens. Mirror the shape
// returned by GET /api/projects/[id]/synthetic.

export interface SyntheticProject {
  id: string;
  title: string;
  engine: string;
  status: string;
  voiceover_url: string | null;
  voiceover_duration_seconds: number | null;
  avatar_image_url: string | null;
  voiceover_source: "tts" | "uploaded" | null;
  tts_voice_id: string | null;
  transcript: string | null;
  script_doc_url: string | null;
  avatar_mark_ranges: Array<{ start: number; end: number }> | null;
}

export interface SyntheticMediaJob {
  id: string;
  type: string;
  status: string;
  progress: number;
  attempts: number;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SyntheticSegmentRow {
  id: string;
  position: number;
  block_type: "avatar" | "image" | "ai_clip" | "split_2";
  start_time: number;
  end_time: number;
  duration: number;
  script: string;
  image_prompt: string | null;
  animation_prompt: string | null;
  status: "pending" | "generating" | "ready" | "failed" | "skipped";
  image_url: string | null;
  video_url: string | null;
  right_image_url: string | null;
  provider: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  // Prior asset versions (newest last), preserved on each regenerate so the
  // review screen can preview + restore them. Empty for never-regenerated rows.
  asset_history?: AssetVersion[] | null;
}

export interface AssetVersion {
  image_url: string | null;
  video_url: string | null;
  right_image_url: string | null;
  provider: string | null;
  created_at?: string;
}

export interface SyntheticResp {
  project: SyntheticProject;
  media_jobs: SyntheticMediaJob[];
  segments: SyntheticSegmentRow[];
  summary: { total: number; ready: number; failed: number; generating: number };
}
