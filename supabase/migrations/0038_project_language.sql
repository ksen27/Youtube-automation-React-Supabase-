-- Narration language for a project (multi-language support, client request
-- 2026-08-17: "expand to the German market").
--
-- WHAT THIS DRIVES
-- ----------------
-- One column, three consumers (all keyed off lib/i18n/locale.ts):
--   * Deepgram alignment — the language is passed EXPLICITLY on /v1/listen.
--     Auto-detection on nova-3 is English-oriented and, when it guesses wrong,
--     returns plausible-but-wrong word timings rather than an error — which
--     silently mis-times every segment in the finished video.
--   * The Gemini planner — picks the regional visual world (a German script
--     renders European streets/homes/cars, not American ones) and forces the
--     image/animation prompts themselves to stay in English for the
--     English-trained image models.
--   * The sentence splitter — German abbreviations ("z.B.", "d.h.") and ordinal
--     dates ("am 1. Januar") end in '.' without ending a sentence.
--
-- Text, not a Postgres enum, matching engine / voiceover_source / aspect_ratio
-- above it: lib/i18n/locale.ts is the source of truth for the value set, and a
-- new language must not require a migration. The CHECK is deliberately omitted
-- for the same reason — getLocale() falls back to English on any unrecognised
-- value, so an unknown code degrades to today's behaviour instead of blocking
-- the write.
--
-- Backfill: NOT NULL DEFAULT 'en' makes every existing project English, which
-- is what they all are. No pipeline behaviour changes for them.
alter table public.projects
  add column if not exists language text not null default 'en';

comment on column public.projects.language is
  'Narration language (lib/i18n/locale.ts LanguageCode: en | de). Drives Deepgram '
  'alignment language, the planner''s regional visual world, and sentence splitting. '
  'Unknown values fall back to English.';

