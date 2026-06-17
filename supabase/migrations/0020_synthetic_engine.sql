-- Synthetic engine — second video-generation pipeline.
--
-- The existing "sourced" engine (download + edit real YouTube footage) is
-- LEFT COMPLETELY UNTOUCHED. Everything here is additive and gated behind
-- projects.engine = 'synthetic'. Existing rows default to 'sourced' so every
-- current query, processor, and UI path behaves exactly as before.
--
-- New synthetic pipeline:
--   transcript/voiceover + avatar image
--     -> 69labs TTS (when transcript-only)            master_voiceover.mp3
--     -> Deepgram alignment (REUSED)                  word/sentence timings
--     -> Gemini planner                               synthetic_segments[]
--     -> per-block asset generation (BullMQ):
--          image     -> 69labs nano-banana (Flux fallback)
--          ai_clip   -> nano-banana image -> fal.ai Veo 3 Fast (Kling fallback)
--          avatar    -> HeyGen (Playwright automation, account rotation)
--          split_2   -> generated image only; avatar reused at render time
--     -> existing render pipeline + buildSplitScreenAvatarVideo()
--
-- Run via the Supabase SQL editor or `supabase db push`.

-- =========================================================================
-- projects — engine selector + synthetic-only inputs
-- =========================================================================
alter table public.projects
  -- 'sourced' (default, existing behaviour) | 'synthetic' (this migration).
  -- Text, not a Postgres enum — the application layer (lib/types.ts) is the
  -- source of truth, matching every other "enum" column in this schema.
  add column if not exists engine           text not null default 'sourced'
                                             check (engine in ('sourced','synthetic')),
  -- Uploaded user photo the HeyGen avatar is generated FROM (R2 public URL).
  add column if not exists avatar_image_url  text,
  -- Output canvas. Synthetic ships 16:9 (1280x720); the column lets a future
  -- 9:16 short reuse the same pipeline without another migration.
  add column if not exists aspect_ratio      text not null default '16:9'
                                             check (aspect_ratio in ('16:9','9:16','1:1')),
  -- 'tts'      -> generate voiceover from transcript via 69labs
  -- 'uploaded' -> user uploaded master_voiceover audio; skip TTS
  add column if not exists voiceover_source  text
                                             check (voiceover_source in ('tts','uploaded')),
  -- Chosen 69labs voice id when voiceover_source = 'tts'.
  add column if not exists tts_voice_id      text;

create index if not exists projects_engine_idx on public.projects (engine);

-- =========================================================================
-- timeline_items — new synthetic block types + asset columns
-- =========================================================================
-- timeline_items.type is a free-text column with no DB-level check (the
-- sourced engine already uses intro/footage/image/split_2/split_4/...), so
-- the new 'avatar' and 'ai_clip' types need no constraint change. We only add
-- the columns that hold synthetic asset references + the planner prompts so a
-- block can be regenerated from the review screen without re-running Gemini.
alter table public.timeline_items
  -- Public R2 URL of the rendered/generated asset for this block:
  --   avatar  -> HeyGen avatar .mp4
  --   ai_clip -> fal.ai animated .mp4
  --   image / split_2 -> generated still (image_url, already exists from 0004)
  add column if not exists video_url        text,
  -- For split_2: the generated still shown on the right; the avatar video is
  -- composited on the left at render time (buildSplitScreenAvatarVideo).
  add column if not exists right_image_url  text,
  -- The Gemini planner prompts, persisted so "Regenerate"/"Edit Prompt" on the
  -- review screen can re-run a single block deterministically.
  add column if not exists image_prompt     text,
  add column if not exists animation_prompt text,
  -- Which media_job last generated this block's asset (diagnostics + retry).
  add column if not exists source_job_id    uuid references public.media_jobs(id) on delete set null;

-- =========================================================================
-- synthetic_segments — planner output, the synthetic analogue of the
-- sourced engine's youtube_search_results: a working table the planner
-- writes and the asset-generation queues consume. Timeline_items are
-- materialized from approved segments at render time, mirroring how the
-- sourced engine materializes timeline_items from clips.
-- =========================================================================
create table if not exists public.synthetic_segments (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects(id) on delete cascade,
  -- 0-based order along the voiceover.
  position          int not null,
  -- avatar | image | ai_clip | split_2 — chosen by Gemini per the planner rules.
  block_type        text not null
                    check (block_type in ('avatar','image','ai_clip','split_2')),
  -- Timings (seconds) aligned to the master voiceover via Deepgram.
  start_time        numeric not null,
  end_time          numeric not null,
  duration          numeric not null,
  -- The narration covered by this segment (drives avatar lip-sync window).
  script            text not null default '',
  -- Generation prompts (style prompt appended at call time, not stored).
  image_prompt      text,
  animation_prompt  text,
  -- Per-block generation lifecycle, independent of the parent media_job so the
  -- progress screen can show completed/total and offer per-block retry.
  status            text not null default 'pending'
                    check (status in ('pending','generating','ready','failed','skipped')),
  -- Generated asset references (filled by the asset processors).
  image_url         text,
  video_url         text,
  right_image_url   text,
  -- Which provider actually produced the asset (e.g. 'veo3_fast','kling',
  -- 'nano_banana','flux','heygen') — for cost attribution + fallback audits.
  provider          text,
  error             text,
  -- Free-form: cost estimate, provider request ids, generation duration, etc.
  metadata          jsonb default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists synthetic_segments_project_id_idx on public.synthetic_segments (project_id);
create index if not exists synthetic_segments_position_idx    on public.synthetic_segments (project_id, position);
create index if not exists synthetic_segments_status_idx       on public.synthetic_segments (status);

drop trigger if exists synthetic_segments_touch on public.synthetic_segments;
create trigger synthetic_segments_touch
  before update on public.synthetic_segments
  for each row execute function public.touch_updated_at();

-- =========================================================================
-- heygen_accounts — pool of HeyGen logins for Playwright automation.
-- Credentials + cookies are AES-256-GCM encrypted at the application layer
-- (lib/crypto/secret-box.ts); only ciphertext is ever stored. The worker
-- rotates accounts on failure and cools down accounts that hit limits.
-- =========================================================================
create table if not exists public.heygen_accounts (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  -- AES-256-GCM ciphertext of the account password (base64). Never plaintext.
  password_enc  text not null,
  -- AES-256-GCM ciphertext of the serialized Playwright storage state
  -- (cookies + localStorage) so a warm session can be restored without a
  -- fresh interactive login. Null until the first successful login persists one.
  cookies_json  text,
  -- 'active'    -> eligible for selection
  -- 'cooldown'  -> temporarily rested after a soft failure / rate limit
  -- 'disabled'  -> taken out of rotation (too many failures, manual disable)
  status        text not null default 'active'
                check (status in ('active','cooldown','disabled')),
  -- Consecutive failures; reset to 0 on a successful avatar generation. The
  -- worker disables an account once this crosses a threshold.
  fail_count    int not null default 0,
  -- When the account becomes eligible again (set when status -> 'cooldown').
  cooldown_until timestamptz,
  last_used_at  timestamptz,
  -- Optional per-account proxy override (ip:port:user:pass). Falls back to the
  -- global HEYGEN_PROXIES pool when null.
  proxy         text,
  metadata      jsonb default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists heygen_accounts_status_idx       on public.heygen_accounts (status);
create index if not exists heygen_accounts_last_used_at_idx  on public.heygen_accounts (last_used_at asc nulls first);

drop trigger if exists heygen_accounts_touch on public.heygen_accounts;
create trigger heygen_accounts_touch
  before update on public.heygen_accounts
  for each row execute function public.touch_updated_at();
