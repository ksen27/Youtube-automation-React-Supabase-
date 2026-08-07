-- =============================================================================
-- 0031 — Ebook Generator product schema (third sidebar product, ported from the
-- standalone ebookgenerator app).
--
-- WHY A DEDICATED SCHEMA, not `public`:
-- this app already owns a `projects` table for the video engines, and the ebook
-- pipeline has its own — a hard collision. Beyond that one clash, the ebook
-- product wants 24 tables with names as generic as `videos`, `channels`,
-- `comments`, `chapters` and `sections`, which would keep colliding with every
-- future video-side migration. Isolating them costs one `search_path` line and
-- removes the whole class of problem.
--
-- HOW THE APP REACHES IT:
-- lib/../packages/ebook-infra/persistence/supabase/SupabaseClientFactory.ts
-- constructs its client with `db: { schema: 'ebook' }`, so all ~65 `.from(...)`
-- calls and the `decrement_pending` RPC resolve here WITHOUT the repositories
-- qualifying any table name. Do not add `ebook.` prefixes in the TS code.
--
-- !! REQUIRED MANUAL STEP !!
-- Supabase → Settings → API → "Exposed schemas": add `ebook`.
-- PostgREST refuses to serve an unexposed schema and every query fails with
-- PGRST106 until this is done. Creating the schema is NOT sufficient.
--
-- The 15 source migrations are inlined below in order, each under its original
-- filename, with two edits:
--   * 0015's single `public.landing_templates` reference is unqualified, so it
--     resolves via search_path like every other statement.
--   * storage buckets are prefixed `ebook-` — storage.buckets is GLOBAL, not
--     schema-scoped, so bare `exports`/`audio` would sit in the same namespace
--     as anything the video side adds later.
--
-- NOTE ON STORAGE: this product uses Supabase Storage while the video engines
-- use Cloudflare R2 (lib/storage.ts). That is a real split worth closing later;
-- it is preserved here so the ported pipeline runs unmodified.
--
-- Apply via the Supabase SQL editor (repo convention). Idempotent at the schema
-- level; the inlined DDL is not re-runnable (plain `create table`), matching how
-- the source migrations were written.
-- =============================================================================

create schema if not exists ebook;

-- Unqualified objects below are created in `ebook`. `auth.*` and `storage.*`
-- stay explicitly qualified in the source SQL, so they are unaffected. `public`
-- is kept on the path for extension-provided functions (gen_random_uuid, etc.).
set search_path = ebook, public;

-- ==========================================================================
-- source: 0001_init.sql
-- ==========================================================================
-- YouTube Ebook Generator — initial schema
-- NOTE (port): upstream this was multi-tenant via owner_id + RLS against
-- auth.users. This app has no per-user accounts — everything sits behind one
-- shared password (lib/auth.ts) — so every RLS policy and the auth.users
-- foreign keys were DROPPED, matching how the video-side tables already work.
-- owner_id itself survives as a plain uuid holding a fixed sentinel; see the
-- comment on projects.owner_id for why.

-- ── enums ────────────────────────────────────────────────────────────────────
create type project_status as enum (
  'CREATED','INGESTING_CHANNEL','FETCHING_VIDEO_DATA','FETCHING_TRANSCRIPTS',
  'TRANSCRIBING_FALLBACK','SUMMARIZING_VIDEOS','SUMMARIZING_CHANNEL',
  'GENERATING_OUTLINE','GENERATING_TOPICS','GENERATING_CHAPTERS',
  'ASSEMBLING','EXPORTING','COMPLETED','PARTIAL','FAILED'
);
create type transcript_source as enum ('youtube','whisper');
create type job_state as enum ('PENDING','RUNNING','COMPLETED','FAILED');
create type content_status as enum ('PENDING','GENERATING','DONE','FAILED');
create type export_format as enum ('pdf','docx');

-- ── projects ─────────────────────────────────────────────────────────────────
create table projects (
  id             uuid primary key default gen_random_uuid(),
  -- Plain uuid, NOT a reference to auth.users and NOT an RLS key — this app has
  -- no per-user accounts. It is retained because the ported domain layer threads
  -- ownerId through the per-owner concurrency cap
  -- (MAX_ACTIVE_PROJECTS_PER_USER / countRunningByOwner), the queued-project
  -- promotion order, and the cross-project sibling checks. The app writes one
  -- fixed sentinel owner (see EBOOK_OWNER_ID), so those all behave as
  -- app-global limits — which is what a single-tenant install wants.
  owner_id       uuid not null,
  channel_url    text not null,
  status         project_status not null default 'CREATED',
  options        jsonb not null default '{}',
  pending_counts jsonb not null default '{}',
  version        int not null default 0,
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- bump version on every update (optimistic concurrency)
create or replace function bump_version() returns trigger language plpgsql as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;
create trigger projects_bump_version before update on projects
  for each row execute function bump_version();

-- ── channels ─────────────────────────────────────────────────────────────────
create table channels (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null unique references projects(id) on delete cascade,
  youtube_id       text not null,
  title            text not null,
  description      text,
  subscriber_count bigint,
  video_count      int,
  thumbnail_url    text,
  raw              jsonb,
  created_at       timestamptz not null default now()
);

-- ── videos ───────────────────────────────────────────────────────────────────
create table videos (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  youtube_id   text not null,
  title        text not null,
  description  text,
  published_at timestamptz,
  duration_s   int,
  view_count   bigint,
  position     int not null,
  has_audio    boolean not null default true,
  status       content_status not null default 'PENDING',
  created_at   timestamptz not null default now(),
  unique (project_id, youtube_id)
);
create index videos_project_idx on videos (project_id);

-- ── transcripts (1:1 video) ──────────────────────────────────────────────────
create table transcripts (
  id         uuid primary key default gen_random_uuid(),
  video_id   uuid not null unique references videos(id) on delete cascade,
  source     transcript_source not null,
  language   text,
  text       text not null,
  segments   jsonb,
  audio_ref  text,
  input_hash text not null,
  created_at timestamptz not null default now()
);

-- ── comments ─────────────────────────────────────────────────────────────────
create table comments (
  id           uuid primary key default gen_random_uuid(),
  video_id     uuid not null references videos(id) on delete cascade,
  youtube_id   text not null,
  author       text,
  text         text not null,
  like_count   int default 0,
  published_at timestamptz,
  unique (video_id, youtube_id)
);
create index comments_video_idx on comments (video_id);

-- ── video summaries ──────────────────────────────────────────────────────────
create table video_summaries (
  id         uuid primary key default gen_random_uuid(),
  video_id   uuid not null unique references videos(id) on delete cascade,
  summary    text not null,
  key_points jsonb,
  themes     jsonb,
  model      text not null,
  input_hash text not null,
  created_at timestamptz not null default now()
);

-- ── channel summary ──────────────────────────────────────────────────────────
create table channel_summaries (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references projects(id) on delete cascade,
  summary    text not null,
  topics     jsonb,
  audience   text,
  tone       text,
  input_hash text not null,
  created_at timestamptz not null default now()
);

-- ── books / outlines / chapters / sections ───────────────────────────────────
create table books (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null unique references projects(id) on delete cascade,
  title        text,
  target_pages int not null default 100,
  status       content_status not null default 'PENDING',
  created_at   timestamptz not null default now()
);

create table outlines (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid not null references books(id) on delete cascade,
  version    int not null default 1,
  structure  jsonb not null,
  input_hash text not null,
  created_at timestamptz not null default now(),
  unique (book_id, version)
);

create table chapters (
  id          uuid primary key default gen_random_uuid(),
  book_id     uuid not null references books(id) on delete cascade,
  position    int not null,
  title       text not null,
  topic       text not null,
  word_target int not null,
  content     text,
  word_count  int default 0,
  status      content_status not null default 'PENDING',
  version     int not null default 1,
  input_hash  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (book_id, position)
);
create index chapters_book_idx on chapters (book_id, position);

create table chapter_versions (
  id         uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references chapters(id) on delete cascade,
  version    int not null,
  content    text not null,
  created_at timestamptz not null default now(),
  unique (chapter_id, version)
);

create table sections (
  id         uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references chapters(id) on delete cascade,
  position   int not null,
  title      text not null,
  prompt     text,
  content    text,
  status     content_status not null default 'PENDING',
  created_at timestamptz not null default now(),
  unique (chapter_id, position)
);

-- ── exports ──────────────────────────────────────────────────────────────────
create table export_artifacts (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  format       export_format not null,
  storage_path text not null,
  byte_size    bigint,
  page_count   int,
  book_version int not null default 1,
  created_at   timestamptz not null default now()
);

-- ── job ledger (idempotency + audit) ─────────────────────────────────────────
create table job_runs (
  job_key    text primary key,
  project_id uuid not null references projects(id) on delete cascade,
  queue      text not null,
  state      job_state not null default 'PENDING',
  attempt    int not null default 0,
  input_hash text,
  result_ref text,
  error      text,
  updated_at timestamptz not null default now()
);
create index job_runs_project_idx on job_runs (project_id, queue, state);

-- ── atomic fan-in barrier ────────────────────────────────────────────────────
create or replace function decrement_pending(p_project uuid, p_stage text)
returns int language sql as $$
  update projects
     set pending_counts = jsonb_set(
           pending_counts, array[p_stage],
           to_jsonb(greatest(coalesce((pending_counts->>p_stage)::int, 0) - 1, 0)))
   where id = p_project
  returning coalesce((pending_counts->>p_stage)::int, 0);
$$;

-- ── RLS ──────────────────────────────────────────────────────────────────────

-- child tables inherit ownership via their project


-- storage buckets (run via Supabase dashboard or storage API): 'audio' (private), 'exports' (private)

-- ==========================================================================
-- source: 0002_full_pipeline.sql
-- ==========================================================================
-- =============================================================================
-- 0002 — Full 15-phase pipeline (logic.md)
-- Adds: comment analysis, channel knowledge base, book strategy, chapter
-- research, richer chapters, and the new pipeline states.
-- =============================================================================

-- ── new project states ───────────────────────────────────────────────────────
-- Postgres enums are append-only; add the new values (idempotent).
alter type project_status add value if not exists 'ANALYZING_COMMENTS' after 'SUMMARIZING_VIDEOS';
alter type project_status add value if not exists 'BUILDING_KNOWLEDGE_BASE' after 'ANALYZING_COMMENTS';
alter type project_status add value if not exists 'GENERATING_BOOK_STRATEGY' after 'BUILDING_KNOWLEDGE_BASE';
alter type project_status add value if not exists 'GENERATING_CHAPTER_RESEARCH' after 'GENERATING_OUTLINE';
alter type project_status add value if not exists 'POLISHING_BOOK' after 'GENERATING_CHAPTERS';

-- ── richer chapters (Phase 9) ────────────────────────────────────────────────
alter table chapters add column if not exists promise text not null default '';
alter table chapters add column if not exists key_points jsonb not null default '[]';

-- ── Phase 6 — comment insights (per video) ───────────────────────────────────
create table if not exists comment_insights (
  id          uuid primary key default gen_random_uuid(),
  video_id    uuid not null unique references videos(id) on delete cascade,
  data        jsonb not null,            -- CommentInsights.toJSON()
  input_hash  text not null,
  created_at  timestamptz not null default now()
);

-- ── Phase 7 — channel knowledge base (per project) ───────────────────────────
create table if not exists channel_knowledge_bases (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null unique references projects(id) on delete cascade,
  data        jsonb not null,            -- ChannelKnowledgeBase.toJSON()
  input_hash  text not null,
  created_at  timestamptz not null default now()
);

-- ── Phase 8 — book strategy (per project) ────────────────────────────────────
create table if not exists book_strategies (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null unique references projects(id) on delete cascade,
  data        jsonb not null,            -- BookStrategy.toJSON()
  input_hash  text not null,
  created_at  timestamptz not null default now()
);

-- ── Phase 10 — chapter research (per chapter) ────────────────────────────────
create table if not exists chapter_research (
  id          uuid primary key default gen_random_uuid(),
  chapter_id  uuid not null unique references chapters(id) on delete cascade,
  project_id  uuid not null references projects(id) on delete cascade,
  data        jsonb not null,            -- ChapterResearch.toJSON()
  input_hash  text not null,
  created_at  timestamptz not null default now()
);

create index if not exists chapter_research_project_idx on chapter_research (project_id);

-- ── RLS: workers use the service-role key (bypass RLS); reads scoped per owner ─


-- ==========================================================================
-- source: 0003_extra_content.sql
-- ==========================================================================
-- =============================================================================
-- 0003 — Phase 13: Optional Extra Content (front/back matter)
-- Book-level sections (introduction, foreword, conclusion, FAQ, bonus chapter,
-- resources, checklist, glossary), distinct from in-chapter `sections`.
-- =============================================================================

create type extra_content_kind as enum (
  'introduction', 'foreword', 'conclusion', 'faq',
  'bonus_chapter', 'resources', 'checklist', 'glossary'
);
create type matter_placement as enum ('front', 'back');

create table if not exists book_sections (
  id          uuid primary key default gen_random_uuid(),
  book_id     uuid not null references books(id) on delete cascade,
  kind        extra_content_kind not null,
  placement   matter_placement not null,
  position    int not null,
  title       text not null,
  prompt      text,
  content     text,
  status      content_status not null default 'PENDING',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists book_sections_book_idx on book_sections (book_id, placement, position);

-- RLS: owner-scoped reads; workers write via the service-role key.

-- ==========================================================================
-- source: 0004_video_knowledge.sql
-- ==========================================================================
-- =============================================================================
-- 0004 — Phase 5: deep Video Knowledge extraction
-- video_summaries now stores the full 10-field VideoKnowledge as a JSONB blob.
-- The legacy key_points/themes columns are kept (nullable) for back-compat reads.
-- =============================================================================

alter table video_summaries add column if not exists data jsonb not null default '{}';

-- Legacy columns are no longer written; relax NOT NULL if it was set.
alter table video_summaries alter column key_points drop not null;
alter table video_summaries alter column themes drop not null;

-- ==========================================================================
-- source: 0005_storage_buckets.sql
-- ==========================================================================
-- =============================================================================
-- 0005 — Storage buckets
-- Creates the private buckets the pipeline writes to, replacing the manual
-- "create these in the dashboard" note in 0001_init.sql with a reproducible
-- migration:
--   'exports' — rendered ebook artifacts (PDF/DOCX), served via signed URLs
--   'audio'   — Whisper audio-fallback downloads
-- Both are private. Worker clients use the service-role key, which bypasses
-- storage RLS, so no storage.objects policies are required for the pipeline.
-- Idempotent: safe to re-run.
-- =============================================================================

insert into storage.buckets (id, name, public)
values
  ('ebook-exports', 'ebook-exports', false),
  ('ebook-audio', 'ebook-audio', false)
on conflict (id) do nothing;

-- ==========================================================================
-- source: 0006_dedication_acknowledgments.sql
-- ==========================================================================
-- =============================================================================
-- 0006 — Add Dedication & Acknowledgments to the extra-content kinds.
-- Every generated book now gets full publishing front/back matter:
--   Dedication → Foreword → Introduction → … chapters … → Conclusion → Acknowledgments
-- =============================================================================

alter type extra_content_kind add value if not exists 'dedication';
alter type extra_content_kind add value if not exists 'acknowledgments';

-- ==========================================================================
-- source: 0007_book_cover_image.sql
-- ==========================================================================
-- =============================================================================
-- 0007 — Per-book cover illustration.
-- Stores the storage path (in the private 'exports' bucket) of the AI-generated
-- cover art, rendered full-bleed behind the typeset title on the PDF cover.
-- =============================================================================

alter table books add column if not exists cover_image_path text;

-- ==========================================================================
-- source: 0008_book_illustrations.sql
-- ==========================================================================
-- =============================================================================
-- 0008 — In-chapter illustrations.
-- AI-generated, full-color editorial illustrations placed throughout the book
-- (roughly one every five finished pages), each matched to the passage it sits
-- beside. Stored in the private 'exports' bucket and inlined as base64 at
-- assemble time (same reason as the cover: Paged.js drops network images after
-- re-chunking the DOM). `order_in_chapter` orders the illustrations within a
-- chapter; the renderer spreads them evenly across that chapter's paragraphs.
-- =============================================================================

create table if not exists book_illustrations (
  id               uuid primary key default gen_random_uuid(),
  book_id          uuid not null references books(id) on delete cascade,
  chapter_id       uuid not null references chapters(id) on delete cascade,
  order_in_chapter int not null,                 -- 0-based slot within the chapter
  storage_path     text not null,                -- path in the 'exports' bucket
  prompt           text,                          -- the (textless) prompt used, for debug/regen
  created_at       timestamptz not null default now(),
  unique (chapter_id, order_in_chapter)          -- idempotent upsert key
);

create index if not exists book_illustrations_book_id_idx on book_illustrations (book_id);

-- ==========================================================================
-- source: 0009_queued_projects.sql
-- ==========================================================================
-- =============================================================================
-- 0009 — Queued projects
-- A user may submit any number of books; only MAX_ACTIVE_PROJECTS_PER_USER run
-- at once. The overflow is accepted and parked in QUEUED, then started by the
-- admission controller as running books reach a terminal state.
-- =============================================================================

-- Postgres enums are append-only; add the new value (idempotent).
-- NOTE: this file deliberately does nothing else. A value added by
-- `alter type ... add value` cannot be USED until the adding transaction has
-- committed, so anything referencing 'QUEUED' has to live in a later migration
-- (see 0010) or it fails with "unsafe use of new value of enum type".
alter type project_status add value if not exists 'QUEUED' before 'CREATED';
