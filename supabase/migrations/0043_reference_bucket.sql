-- =============================================================================
-- 0043 — Storage bucket for uploaded reference books.
--
-- PRIVATE. These are whole published books the user supplied; a public bucket
-- would put them behind a guessable URL. Everything that reads them does so
-- server-side with the service-role key, and the browser only ever gets a
-- short-lived signed URL to WRITE one.
--
-- The 100MB limit matches MAX_REFERENCE_BYTES in StartReferenceUploadUseCase.
-- Both exist deliberately: the app-side check gives a readable error before the
-- upload starts, this one is the guarantee — a signed URL is handed to a
-- browser, and nothing stops that browser from sending more than it declared.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ebook-references',
  'ebook-references',
  false,
  104857600, -- 100MB
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown'
  ]
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
