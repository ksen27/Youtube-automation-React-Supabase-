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
  | "failed"
  // --- synthetic engine statuses (additive; sourced engine never sets these) ---
  | "created"
  | "voiceover"
  | "aligning"
  | "planning"
  // Planner finished; segments are planned but assets are NOT yet generated.
  // The review gate — the user inspects/edits the plan then clicks Generate.
  | "plan_ready"
  | "generating_images"
  | "generating_clips"
  | "generating_avatars";

// Which generation pipeline a project runs through. 'sourced' is the original
// (and DB default) engine; 'synthetic' is the AI-generated pipeline added in
// migration 0020. Branch on this — NEVER change behaviour for 'sourced'.
export type Engine = "sourced" | "synthetic";

export type AspectRatio = "16:9" | "9:16" | "1:1";

export type VoiceoverSource = "tts" | "uploaded";

// The four synthetic visual block types Gemini chooses between (see planner).
export type SyntheticBlockType = "avatar" | "image" | "ai_clip" | "split_2";

export type SyntheticSegmentStatus =
  | "pending"
  | "generating"
  | "ready"
  | "failed"
  | "skipped";

// Planner output / asset-generation working row (table synthetic_segments).
export interface SyntheticSegment {
  id: string;
  project_id: string;
  position: number;
  block_type: SyntheticBlockType;
  start_time: number;
  end_time: number;
  duration: number;
  script: string;
  image_prompt: string | null;
  animation_prompt: string | null;
  status: SyntheticSegmentStatus;
  image_url: string | null;
  video_url: string | null;
  right_image_url: string | null;
  provider: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// 'needs_reauth' — the stored storageState is missing or expired; the account
// is out of rotation WITHOUT cooldown until a human re-runs `heygen:connect`.
export type HeygenAccountStatus = "active" | "cooldown" | "disabled" | "needs_reauth";

export interface HeygenAccount {
  id: string;
  email: string;
  password_enc: string;
  cookies_json: string | null;
  status: HeygenAccountStatus;
  fail_count: number;
  cooldown_until: string | null;
  last_used_at: string | null;
  // Per-job LEASE for parallel avatar generation (migration 0026). claimed_until
  // is the lease expiry (NULL = free / claimable); claimed_by is an opaque
  // worker token. A lease is a healthy-but-busy marker, distinct from a
  // cooldown/needs_reauth penalty. See lib/synthetic/heygen-accounts.ts.
  claimed_until: string | null;
  claimed_by: string | null;
  proxy: string | null;
  // Last failure classification + reason, surfaced in the settings UI so an
  // operator can tell a stale session apart from a real account problem.
  last_error_class: string | null;
  last_error: string | null;
  // When the storageState was last successfully (re)connected by a human.
  auth_saved_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

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
  // --- synthetic engine columns (migration 0020; null/default for sourced) ---
  engine: Engine;
  avatar_image_url: string | null;
  aspect_ratio: AspectRatio;
  voiceover_source: VoiceoverSource | null;
  tts_voice_id: string | null;
  // --- sales-pitch video insertion (migration 0025; synthetic-only) ---
  pitch_video_url: string | null;
  pitch_video_duration_seconds: number | null;
  pitch_video_insert_seconds: number;
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
  | "transition"
  // --- synthetic engine block types (additive) ---
  | "avatar"
  | "ai_clip";

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
  | "render"
  // Pre-downloads one script-doc marker's YouTube window into R2 (clip
  // .mp4 always; .m4a audio for intro_card kinds). The script-doc API
  // enqueues one job per marker right after persisting them so the user
  // can watch download progress on the intake screen before generate.
  | "script_clip"
  // --- synthetic engine job types (migration 0020) ---
  | "tts"             // 69labs voiceover generation (transcript -> mp3)
  | "plan_synthetic"  // Gemini planner -> synthetic_segments[]
  | "avatar"          // HeyGen avatar video (Playwright automation)
  | "image_gen"       // 69labs nano-banana image (Flux fallback)
  | "image_to_video"; // nano-banana image -> fal.ai Veo Fast (Kling fallback)
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
