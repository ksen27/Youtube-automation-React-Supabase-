-- =============================================================================
-- 0032 — Ebook schema, part 2: objects that REFERENCE newly-added enum values.
--
-- Split from 0031 on purpose, and it must stay split. Postgres will not let a
-- value added by `alter type ... add value` be USED until the transaction that
-- added it has committed — otherwise it fails with
--   ERROR: unsafe use of new value "QUEUED" of enum type project_status
-- 0031 adds 'QUEUED' (and several project_status / extra_content_kind values);
-- everything below references them, so it has to run as a SEPARATE statement
-- batch. The upstream migrations split 0009/0010 for exactly this reason; the
-- consolidation into one file re-broke it, and this restores the boundary.
--
-- Run AFTER 0031 has been applied and committed.
-- =============================================================================

set search_path = ebook, public;

-- ==========================================================================
-- source: 0010_queued_projects_index.sql
-- ==========================================================================
-- =============================================================================
-- 0010 — Index for the queued-project admission controller
-- Separate from 0009 because the 'QUEUED' enum value can only be referenced
-- once the transaction that added it has committed.
-- =============================================================================

-- Promotion picks a user's queued projects oldest-first; this keeps that on an
-- index rather than scanning every project the owner has ever created.
create index if not exists projects_owner_queued_idx
  on projects (owner_id, created_at)
  where status = 'QUEUED';

-- ==========================================================================
-- source: 0011_landing_pages.sql
-- ==========================================================================
-- =============================================================================
-- 0011 — Sales landing pages.
-- One optional page per project: Claude writes the copy, the palette is derived
-- from the book's own cover art, and the rendered HTML is deployed to Netlify.
--
-- The rendered `html` is stored rather than re-rendered on demand so that the
-- bytes the user previewed are exactly the bytes that get published.
--
-- Commerce settings (price, checkout URL) deliberately live in projects.options
-- alongside the other per-project settings — this table holds only the
-- generated artifact and its deployment record.
-- =============================================================================

create type landing_page_state as enum ('GENERATING','DRAFT','PUBLISHING','PUBLISHED','FAILED');

create table landing_pages (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null unique references projects(id) on delete cascade,
  state       landing_page_state not null default 'GENERATING',
  copy        jsonb,
  palette     jsonb,
  html        text,
  -- Netlify identifiers; null until the first successful publish.
  site_id     text,
  deploy_id   text,
  url         text,
  -- Hash of every generation input — an unchanged hash short-circuits a re-run.
  input_hash  text,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Ownership flows through the project, matching every other child table.

-- ==========================================================================
-- source: 0012_landing_layouts.sql
-- ==========================================================================
-- =============================================================================
-- 0012 — Reusable landing-page layouts, one per reference template.
--
-- Before this, every book re-derived its own layout from the reference site.
-- That was expensive (a 30k-token Opus call per book) and, more importantly,
-- wrong: the client's requirement is that every page follow the SAME template,
-- and a fresh interpretation each run produces a different page each time.
--
-- A layout is now captured ONCE per (reference_url, mode) and reused. Its
-- markup carries {{COPY:key}} slots instead of any book's words, and `slots`
-- describes each one for the copywriter. Filling those slots is what makes a
-- page for a particular book.
--
-- Deliberately NOT owned by a project or a user: a layout is markup derived
-- from a public web page with the text removed, so there is nothing in it that
-- belongs to one account. Sharing it is what makes the cache worth having.
-- =============================================================================

create table landing_layouts (
  id            uuid primary key default gen_random_uuid(),
  -- The reference site this layout was copied from.
  reference_url text not null,
  -- 'single' | 'triple' — the two templates are not interchangeable, so each
  -- mode gets its own layout even from the same URL.
  mode          text not null default 'single',
  css           text not null,
  -- Markup with {{COPY:…}} slots where a book's prose goes.
  body_html     text not null,
  -- [{ key, purpose, maxChars }] — the brief handed to the copy call.
  slots         jsonb not null default '[]'::jsonb,
  -- Hash of the inputs that produced it; a change re-derives the layout.
  input_hash    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (reference_url, mode)
);

create index landing_layouts_lookup on landing_layouts (reference_url, mode);

-- Readable by any signed-in user (it is a template, not anyone's data); only
-- the service role writes, because layouts are produced by the worker.

-- ==========================================================================
-- source: 0013_landing_templates.sql
-- ==========================================================================
-- =============================================================================
-- 0013 — Cloned landing page templates.
--
-- Replaces the model-authored layouts of 0012. The difference is what is stored:
-- a `landing_layouts` row held CSS and markup that Claude WROTE after looking at
-- a reference site. A `landing_templates` row holds the reference site's OWN
-- rendered DOM and stylesheets, cleaned and parameterised. Nothing in it was
-- authored by a model — the only model output involved is a mapping of which
-- nodes hold product content, and that mapping is applied by deterministic code.
--
-- Consequences of that difference, both encoded below:
--
--   · Owner-scoped, unlike 0012. A layout was neutral markup with every word
--     stripped out, so sharing it across accounts cost nobody anything. A
--     template is a complete copy of a website — sharing one leaks which
--     template a seller uses, and raises an IP question that is not ours to
--     answer on the client's behalf.
--
--   · Blobs live in storage, not in the row. The rendered HTML plus a full CSS
--     bundle runs to hundreds of KB, and this project already learned what
--     multi-hundred-KB writes do to a single PostgREST request (see the
--     INLINE_WIDTHS docstring in GenerateLandingPageUseCase — Postgres 57014 on
--     one attempt, a Cloudflare 502 on the next). The row holds pointers.
-- =============================================================================

create type landing_template_state as enum ('EXTRACTING','READY','FAILED');

create table landing_templates (
  id                    uuid primary key default gen_random_uuid(),
  -- Plain uuid, no auth.users FK — see the note on projects.owner_id.
  owner_id              uuid not null,
  source_url            text not null,
  state                 landing_template_state not null default 'EXTRACTING',

  -- Human label, defaulted from the source page's <title>.
  name                  text,

  -- Paths in the private 'landing-assets' bucket.
  -- `original_html_path` is forensic: exactly what the browser rendered, before
  -- any cleaning. Kept so a fidelity complaint can be answered by diffing
  -- against what we actually saw, rather than against the live site as it is
  -- today.
  original_html_path    text,
  clean_html_path       text,   -- parameterised, carries {{TOKEN}}s
  css_bundle_path       text,

  -- [{ tplId, placeholder, kind, maxChars, originalText, hadInlineMarkup }]
  placeholder_map       jsonb not null default '[]'::jsonb,
  -- [{ key, containerTplId, originalCount, layoutMode, fields }]
  repeater_map          jsonb not null default '[]'::jsonb,
  -- { accentToken, accentValue, onAccentValue, isDark, rootTokens }
  theme_tokens          jsonb not null default '{}'::jsonb,
  -- { breakpoints: number[], sections: [{tplId, width, rect, paddingBlock, background}] }
  responsive_rules      jsonb not null default '{}'::jsonb,
  -- [{ width, storagePath }] — the visual baseline every generated page is
  -- diffed against.
  baseline_shots        jsonb not null default '[]'::jsonb,

  -- User corrections to the map, re-applied on every re-extraction so review
  -- work survives a refresh of the source site. Keyed on placeholder name
  -- rather than on tplId: node ids move when the source page changes, but the
  -- decision "this node is the hero subtitle" does not.
  placeholder_overrides jsonb not null default '[]'::jsonb,

  -- Warnings, unreplaced assets, font fidelity, cleaning loss. Surfaced in the
  -- UI: a template that lost its webfonts or dropped four photographs is still
  -- usable, but the seller must be told before they build a page on it.
  extraction_report     jsonb,
  failure_reason        text,

  -- Bumped in code (LANDING_PIPELINE_VERSION) on any change to capture,
  -- cleaning, annotation or parameterisation. This is what makes a pipeline fix
  -- reach existing templates instead of sitting behind a manual rebuild flag —
  -- the defect that made every prompt fix to the 0012 path invisible.
  pipeline_version      int  not null,
  revision              int  not null default 1,

  captured_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (owner_id, source_url, pipeline_version, revision)
);

create index landing_templates_owner on landing_templates (owner_id, state);

-- One row per re-hosted asset. Deliberately rows rather than a jsonb array on
-- the template: the deploy enumerates them, a future GC job needs to find
-- orphans, and content-hash dedup across templates falls out for free.
create table landing_template_assets (
  id             uuid primary key default gen_random_uuid(),
  template_id    uuid not null references landing_templates(id) on delete cascade,
  content_hash   text not null,
  -- Path inside the deployed site, e.g. 'assets/a1b2c3d4.woff2'.
  site_path      text not null,
  storage_path   text not null,
  content_type   text not null,
  byte_size      int  not null,
  kind           text not null,          -- 'image' | 'font' | 'other'
  source_url     text,
  -- False for a font whose licence does not permit redistribution. It is
  -- recorded (so the report can say the typeface degraded) but not stored, and
  -- the font-family stack falls back on the published page.
  rehosted       boolean not null default true,
  created_at     timestamptz not null default now(),

  unique (template_id, site_path)
);

create index landing_template_assets_template on landing_template_assets (template_id);



-- ── landing_pages: which template, which engine, and how faithful ───────────
alter table landing_pages
  add column template_id uuid references landing_templates(id) on delete set null,
  -- 'clone' | 'builtin'. Today this is decided silently by whether a layout
  -- derivation happened to succeed, is logged once in the worker, and is
  -- invisible to the person looking at the page.
  add column engine      text not null default 'builtin',
  -- The bound slot values. Stored so one headline can be corrected and the page
  -- re-bound without re-asking Claude for the whole page.
  add column binding     jsonb,
  -- [{ sitePath, storagePath, contentType }] — what this page's deploy ships
  -- alongside index.html.
  add column assets      jsonb not null default '[]'::jsonb,
  -- The post-bind verification report. Publishing is gated on it having no
  -- BLOCKER-severity findings.
  add column fidelity    jsonb,
  -- Pointer into 'landing-assets', replacing the inline `html` column. Both
  -- exist during the migration; `html` is dropped once the clone engine is the
  -- default and no page is still being served from it.
  add column html_path   text;

-- ==========================================================================
-- source: 0014_landing_assets_bucket.sql
-- ==========================================================================
-- =============================================================================
-- 0014 — Storage bucket for cloned template artifacts.
--
-- Holds the captured HTML, the CSS bundle, the re-hosted images and fonts, the
-- baseline screenshots, and each generated page's final HTML.
--
-- Private, like 'exports'. Nothing here is ever served to the public from
-- Supabase: the worker reads the bytes with the service-role key and uploads
-- them to Netlify as part of a deploy, so the only public copy is the one on
-- the seller's own site.
--
-- Idempotent: safe to re-run.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('ebook-landing-assets', 'ebook-landing-assets', false)
on conflict (id) do nothing;

-- ==========================================================================
-- source: 0015_landing_template_typography.sql
-- ==========================================================================
-- The template's measured typography.
--
-- The clone pipeline strips every captured @font-face and re-adds only the
-- faces whose licence permits redistribution, but the font-family declarations
-- naming them survive untouched. With no record of what the typefaces WERE, a
-- face that could not be embedded left the page asking for a font nobody has,
-- and the browser fell back to its own default — so cloned pages matched their
-- template everywhere except the type.
--
-- Reading it from the live page rather than from the stylesheet is the point:
-- `font-family: var(--font-display)` only resolves to a real family in the
-- browser, and parsing the declaration is what previously made a serif template
-- come out sans-serif.
--
-- { heading: {family, stack, weight, serif} | null,
--   body:    {family, stack, weight, serif} | null,
--   familiesUsed: string[] }
alter table landing_templates
  add column if not exists typography_tokens jsonb not null default '{}'::jsonb;

-- Existing rows have no measurement and cannot be back-filled without
-- re-capturing the source site. LANDING_PIPELINE_VERSION is bumped to 2 in the
-- same change, so each template re-extracts on next use and populates this
-- then; until it does, the empty default reads back as "nothing measured",
-- which is the honest value and the one the code already handles.
-- search_path is session-scoped and ends with this script; nothing to reset.
