-- Thumbnail personas — Pikzels identity-lock for the /thumbnails feature.
--
-- WHY: Pikzels' create-from-image endpoint uses an uploaded face only as a
-- STARTING POINT and regenerates a NEW person from the prompt — it does NOT
-- preserve the exact face. So "change a channel's AI avatar to a new face"
-- produced a different-looking person (the client's bug: the new Ruth Yoder
-- face was ignored / drifted).
--
-- Pikzels' actual identity mechanism is a PERSONA (a "pikzonality"): you POST 3
-- face images to /v2/pikzonality/persona, poll GET /v2/pikzonality/{id} until
-- status='completed' (~60s, async), then pass `persona: <id>` to the thumbnail
-- generate call to LOCK that exact face while the prompt drives the scene.
--
-- Building a persona is slow + costs an API call, so we CACHE the persona id
-- keyed by the uploaded face image URL: the same uploaded face reuses its
-- persona across titles AND channels, and is only built once.
--
-- Run via the Supabase SQL editor or `supabase db push`.

create table if not exists public.thumbnail_personas (
  id             uuid primary key default gen_random_uuid(),
  -- The uploaded face image URL (R2) this persona was built from. This is the
  -- cache key: a repeated upload of the same face reuses the same persona.
  face_url       text not null,
  -- The Pikzels persona ("pikzonality") id, set once creation is accepted.
  -- Null only in the brief window between insert and the create call returning.
  persona_id     text,
  -- Mirrors Pikzels' persona status so we can reuse a 'completed' persona
  -- immediately and re-poll/rebuild a 'processing'/'failed' one.
  --   pending    -> row inserted, create-persona not yet confirmed
  --   processing -> Pikzels is building it (poll GET /v2/pikzonality/{id})
  --   completed  -> ready; pass persona_id to generate
  --   failed     -> Pikzels build failed; error set, safe to rebuild
  status         text not null default 'pending'
                   check (status in ('pending','processing','completed','failed')),
  -- Failure reason when status = 'failed'.
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One persona per uploaded face URL — the reuse cache key. A repeated upload of
-- the same face hits this row instead of rebuilding.
create unique index if not exists thumbnail_personas_face_url_idx
  on public.thumbnail_personas (face_url);
