-- Script-doc markers. The intake flow no longer accepts a pasted transcript
-- — the user provides a Google Docs link whose formatting carries editorial
-- intent:
--   • Blue-bold blocks at the TOP of the doc, before any prose paragraph,
--     are intro clips. Each one plays back-to-back as a pre-roll with its
--     own original audio; the title text (if any) is captured but never
--     shown on screen. Multiple intros = multiple clips concatenated.
--   • Blue-bold blocks AFTER prose begins are title cards. The blue text
--     flashes as an overlay when its phrase is spoken in the voiceover,
--     then the renderer cuts and plays exactly the YouTube window listed
--     under the title — no search, no ranking.
--   • Red text runs inline in regular paragraphs are lower-thirds. While the
--     narrator says these words, a drawtext overlay shows them.
--
-- We persist a row per non-intro marker so:
--   1. The matcher can align each marker's text to Deepgram's per-word
--      timings (transcript_words on projects) and insert a timeline item at
--      that exact moment.
--   2. The downloader can fetch the forced title-card clip up-front with the
--      same proxy-rotation pipeline that handles the regular source pool.
--   3. Reviewers can audit what the doc-parser saw (paragraph_index +
--      char_offset are useful when the parser misreads a run).
create table if not exists public.project_script_markers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null check (kind in ('intro_card', 'title_card', 'lower_third')),
  -- Plain text of the run as it appears in the doc — also what we look for
  -- in the Deepgram-aligned word stream. Casing/punctuation may differ;
  -- the matcher normalizes both sides before comparison.
  text text not null,
  -- Index of the marker within the full doc text, used to break ties when
  -- the same phrase appears multiple times (we align the Nth occurrence in
  -- the script to the Nth occurrence in the spoken audio).
  ordinal int not null,
  -- Paragraph index in the parsed doc (0-based, intro paragraph excluded).
  -- Helps the lower-third placer locate the right surrounding paragraph
  -- when the same phrase repeats inside one paragraph.
  paragraph_index int,
  -- Character offset of the marker's first character within its paragraph.
  -- Combined with paragraph_index this uniquely places the marker.
  char_offset int,
  -- Intro-card and title-card markers carry a forced YouTube source +
  -- window. Lower-third markers leave all three null.
  youtube_url text,
  start_seconds numeric,
  end_seconds numeric,
  -- After the matcher resolves the marker against the spoken audio, we
  -- persist the resulting timestamp here so the export UI / reviewer can
  -- see "this card fires at 1:23 in the final video" without re-running the
  -- alignment. Null until the matcher runs.
  resolved_audio_seconds numeric,
  created_at timestamptz not null default now()
);

create index if not exists project_script_markers_project_id_idx
  on public.project_script_markers (project_id, ordinal);
