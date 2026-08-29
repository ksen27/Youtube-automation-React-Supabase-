-- =============================================================================
-- 0041 — Reference books: the library a new book is generated FROM.
--
-- Replaces the channel as the ebook pipeline's source of material. A user picks
-- a title and one or more reference books; the pipeline writes a new book in
-- their voice and structure. See the removal commit for what this displaces.
--
-- WHY A LIBRARY RATHER THAN A PER-PROJECT UPLOAD
-- ----------------------------------------------
-- The requirement is "upload a reference book, OR select one uploaded before",
-- so a reference has to outlive the project it was first used for and be
-- reusable across many. That makes it its own entity with its own lifetime,
-- not a column on `projects`.
--
-- TWO KINDS OF REFERENCE, ONE TABLE
-- ---------------------------------
-- `upload`    — a file the user supplied. Its bytes live in object storage and
--               its text is extracted into reference_sections on ingest.
-- `generated` — a book THIS system already produced. Its chapters are already
--               structured text in `chapters`, so it needs no file and no
--               parsing: seeding it is a copy, which is how the ten existing
--               books enter the library.
-- The CHECK constraint below is what keeps the two honest — a row cannot claim
-- to be an upload with no file, or generated with no origin.
-- =============================================================================

set search_path = ebook, public;

create type reference_source as enum ('upload', 'generated');

create table reference_books (
  id                uuid primary key default gen_random_uuid(),
  -- Plain uuid, matching `projects.owner_id` — this app has no per-user
  -- accounts and these tables carry no RLS (see the note in 0031).
  owner_id          uuid not null,
  title             text not null,
  author            text,
  source            reference_source not null,

  -- source = 'generated': the project whose finished book this is. ON DELETE
  -- SET NULL, not CASCADE: deleting an old project must not silently remove a
  -- reference that later books were written from — the extracted text stands on
  -- its own once copied.
  origin_project_id uuid references projects(id) on delete set null,

  -- source = 'upload': where the original file sits, for re-extraction if the
  -- parser improves. The TEXT is the durable artifact, not the file.
  storage_path      text,
  content_type      text,
  byte_size         bigint,

  -- Extraction lifecycle. A reference is not selectable until it is DONE:
  -- a half-parsed book would produce a book written from half a voice.
  status            content_status not null default 'PENDING',
  error             text,
  word_count        int not null default 0,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint reference_books_source_shape check (
    (source = 'generated' and origin_project_id is not null)
    or (source = 'upload' and storage_path is not null)
  )
);

-- The library listing: one owner's references, newest first.
create index reference_books_owner_idx on reference_books (owner_id, created_at desc);

-- The retrievable unit. Chapter research ranks these by overlap with the
-- chapter it is researching, exactly as it once ranked video summaries — which
-- is why the text is stored in sections rather than as one blob.
create table reference_sections (
  id                uuid primary key default gen_random_uuid(),
  reference_book_id uuid not null references reference_books(id) on delete cascade,
  position          int not null,
  title             text,
  content           text not null,
  word_count        int not null default 0,
  created_at        timestamptz not null default now(),
  unique (reference_book_id, position)
);
create index reference_sections_book_idx on reference_sections (reference_book_id, position);

-- Which references a project was generated from. Ordered: the first is the
-- primary voice, the rest are supporting.
create table project_reference_books (
  project_id        uuid not null references projects(id) on delete cascade,
  -- RESTRICT, deliberately: a finished book's provenance is not something a
  -- library tidy-up gets to erase. Detach it from the project first if the
  -- reference genuinely has to go.
  reference_book_id uuid not null references reference_books(id) on delete restrict,
  position          int not null,
  created_at        timestamptz not null default now(),
  primary key (project_id, reference_book_id),
  unique (project_id, position)
);

-- Grants for the new tables. 0033 sets DEFAULT PRIVILEGES for role postgres in
-- this schema, so these are belt-and-braces for the case where a migration is
-- applied by a different role — the failure mode it prevents is a 42501 that
-- surfaces mid-pipeline rather than at submit.
grant all privileges on reference_books to anon, authenticated, service_role;
grant all privileges on reference_sections to anon, authenticated, service_role;
grant all privileges on project_reference_books to anon, authenticated, service_role;
