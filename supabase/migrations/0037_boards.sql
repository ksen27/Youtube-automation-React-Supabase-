-- =========================================================================
-- 0037 — Boards: a Trello-style project management surface.
--
-- WHY A NEW SET OF TABLES: the existing `projects` table models a VIDEO JOB
-- (engine, status, render pipeline). It is not a workspace and cannot host
-- arbitrary work items without corrupting the pipeline's status machine. A
-- board is therefore its own aggregate — but it can OPTIONALLY point at a
-- video project (`boards.project_id`) so a team can track the work around a
-- specific video without duplicating the project concept.
--
-- IDENTITY / PERMISSIONS NOTE (important, read before adding RLS):
-- this app has no per-user accounts. Every request is already gated by the
-- shared-password check in proxy.ts (see the note in 0033) and the server uses
-- the service-role key. `board_members` therefore models COLLABORATORS — named
-- people on a board, with a role — not authenticated principals. The role is a
-- collaboration guardrail (who may restructure the board), enforced server-side
-- for the identity a client claims; it is NOT a security isolation boundary.
-- If real auth ever lands, add `user_id uuid` to board_members, backfill it,
-- and put RLS on every table here.
--
-- ORDERING: lists and cards use a fractional `position` (double precision), the
-- same approach Trello uses. Inserting between two neighbours takes their
-- midpoint, so a move is ONE row update rather than a rewrite of the whole
-- column. Doubles run out of precision after ~50 consecutive midpoints between
-- the same pair, so the API calls the normalize functions below when a gap gets
-- too small. Never rely on array index — positions are the source of truth.
--
-- Apply via the Supabase SQL editor or `supabase db push`. Safe to re-run.
-- =========================================================================

-- ---------------------------------------------------------------------------
-- Boards
-- ---------------------------------------------------------------------------
create table if not exists public.boards (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text not null default '',
  -- Optional link to a video project. ON DELETE SET NULL: deleting a video
  -- project must never take the team's task history with it.
  project_id  uuid references public.projects(id) on delete set null,
  -- Board theme key (rendered from the app's design tokens, see
  -- lib/boards/theme.ts). Not a free-form colour so the UI stays on-palette.
  theme       text not null default 'indigo',
  -- 'workspace' = everyone with the shared password sees it in the board list;
  -- 'private'   = hidden from the list, reachable only by direct link. With a
  -- single shared password this is organisational hygiene, not access control.
  visibility  text not null default 'workspace'
                check (visibility in ('workspace','private')),
  -- Monotonic counter bumped by triggers on every child write. The SSE stream
  -- polls this ONE integer instead of diffing the whole board, which keeps the
  -- realtime endpoint cheap no matter how large the board gets.
  revision    bigint not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists boards_active_idx
  on public.boards (updated_at desc) where archived_at is null;
create index if not exists boards_project_idx
  on public.boards (project_id) where project_id is not null;

-- ---------------------------------------------------------------------------
-- Members — named collaborators on a board (see the identity note above).
-- ---------------------------------------------------------------------------
create table if not exists public.board_members (
  id           uuid primary key default gen_random_uuid(),
  board_id     uuid not null references public.boards(id) on delete cascade,
  display_name text not null,
  -- owner  — full control incl. deleting the board and managing members
  -- member — everyday work: lists, cards, comments, moves
  -- viewer — read-only, may still comment
  role         text not null default 'member'
                 check (role in ('owner','member','viewer')),
  -- Avatar tint key from the design system (lib/boards/theme.ts).
  color        text not null default 'indigo',
  created_at   timestamptz not null default now()
);

-- One person per board, case-insensitively — stops "Sara" and "sara" splitting
-- one person's assignments across two rows.
create unique index if not exists board_members_unique_name_idx
  on public.board_members (board_id, lower(display_name));
create index if not exists board_members_board_idx
  on public.board_members (board_id);

-- The board's owner. Added after board_members exists so the FK can be real.
alter table public.boards
  add column if not exists owner_member_id uuid
    references public.board_members(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Lists (columns)
-- ---------------------------------------------------------------------------
create table if not exists public.board_lists (
  id          uuid primary key default gen_random_uuid(),
  board_id    uuid not null references public.boards(id) on delete cascade,
  title       text not null,
  position    double precision not null,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The board render reads lists by board in position order — this index serves
-- that query directly, and being partial means archived columns cost nothing.
create index if not exists board_lists_board_position_idx
  on public.board_lists (board_id, position) where archived_at is null;

-- ---------------------------------------------------------------------------
-- Cards
-- ---------------------------------------------------------------------------
create table if not exists public.board_cards (
  id              uuid primary key default gen_random_uuid(),
  -- board_id is denormalised from the list so board-wide reads (the whole
  -- board, search, filters) are a single indexed scan instead of a join. Kept
  -- in sync by the move function below, which is the only writer of list_id.
  board_id        uuid not null references public.boards(id) on delete cascade,
  list_id         uuid not null references public.board_lists(id) on delete cascade,
  title           text not null,
  description     text not null default '',
  position        double precision not null,
  completed       boolean not null default false,
  start_at        timestamptz,
  due_at          timestamptz,
  cover_color     text,
  cover_image_url text,
  created_by      uuid references public.board_members(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  archived_at     timestamptz
);

create index if not exists board_cards_list_position_idx
  on public.board_cards (list_id, position) where archived_at is null;
create index if not exists board_cards_board_idx
  on public.board_cards (board_id) where archived_at is null;
-- Due-date filters ("overdue", "due this week") scan by board + due date.
create index if not exists board_cards_due_idx
  on public.board_cards (board_id, due_at)
  where archived_at is null and due_at is not null;

-- ---------------------------------------------------------------------------
-- Labels — defined per board, attached to many cards.
-- ---------------------------------------------------------------------------
create table if not exists public.board_labels (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.boards(id) on delete cascade,
  name       text not null default '',
  -- Design-system colour key (lib/boards/theme.ts), not a hex value, so labels
  -- stay legible on the app's dark surfaces.
  color      text not null,
  position   double precision not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists board_labels_board_idx
  on public.board_labels (board_id, position);

create table if not exists public.board_card_labels (
  card_id  uuid not null references public.board_cards(id) on delete cascade,
  label_id uuid not null references public.board_labels(id) on delete cascade,
  primary key (card_id, label_id)
);

-- Reverse lookup: "which cards carry this label" for the label filter.
create index if not exists board_card_labels_label_idx
  on public.board_card_labels (label_id);

-- ---------------------------------------------------------------------------
-- Card assignments
-- ---------------------------------------------------------------------------
create table if not exists public.board_card_members (
  card_id    uuid not null references public.board_cards(id) on delete cascade,
  member_id  uuid not null references public.board_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (card_id, member_id)
);

create index if not exists board_card_members_member_idx
  on public.board_card_members (member_id);

-- ---------------------------------------------------------------------------
-- Checklists
-- ---------------------------------------------------------------------------
create table if not exists public.board_checklists (
  id         uuid primary key default gen_random_uuid(),
  card_id    uuid not null references public.board_cards(id) on delete cascade,
  title      text not null default 'Checklist',
  position   double precision not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists board_checklists_card_idx
  on public.board_checklists (card_id, position);

create table if not exists public.board_checklist_items (
  id                 uuid primary key default gen_random_uuid(),
  checklist_id       uuid not null references public.board_checklists(id) on delete cascade,
  title              text not null,
  completed          boolean not null default false,
  position           double precision not null,
  assignee_member_id uuid references public.board_members(id) on delete set null,
  due_at             timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists board_checklist_items_checklist_idx
  on public.board_checklist_items (checklist_id, position);

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
create table if not exists public.board_card_comments (
  id               uuid primary key default gen_random_uuid(),
  card_id          uuid not null references public.board_cards(id) on delete cascade,
  -- Denormalised so the revision trigger is a single indexed update.
  board_id         uuid not null references public.boards(id) on delete cascade,
  author_member_id uuid references public.board_members(id) on delete set null,
  content          text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists board_card_comments_card_idx
  on public.board_card_comments (card_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Attachments — a link, or an R2 object uploaded through the presign route.
-- ---------------------------------------------------------------------------
create table if not exists public.board_card_attachments (
  id           uuid primary key default gen_random_uuid(),
  card_id      uuid not null references public.board_cards(id) on delete cascade,
  board_id     uuid not null references public.boards(id) on delete cascade,
  name         text not null,
  url          text not null,
  -- Null for pure links; set for objects uploaded to R2 (kept so a future
  -- cleanup job can delete the object when the row goes away).
  storage_key  text,
  content_type text,
  size_bytes   bigint,
  added_by     uuid references public.board_members(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists board_card_attachments_card_idx
  on public.board_card_attachments (card_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Activity — STRUCTURED events, never pre-rendered sentences. The UI builds the
-- wording from action_type + metadata (lib/boards/activity.ts), so copy and
-- translations can change without a data migration.
-- ---------------------------------------------------------------------------
create table if not exists public.board_activity (
  id              uuid primary key default gen_random_uuid(),
  board_id        uuid not null references public.boards(id) on delete cascade,
  card_id         uuid references public.board_cards(id) on delete cascade,
  actor_member_id uuid references public.board_members(id) on delete set null,
  action_type     text not null,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists board_activity_board_idx
  on public.board_activity (board_id, created_at desc);
create index if not exists board_activity_card_idx
  on public.board_activity (card_id, created_at desc) where card_id is not null;

-- ===========================================================================
-- Triggers: updated_at + the board revision counter
-- ===========================================================================

create or replace function public.board_touch_updated_at()
returns trigger language plpgsql as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

-- Bump the revision of the board named directly on the row.
create or replace function public.board_bump_revision_by_board()
returns trigger language plpgsql as $fn$
declare
  target uuid := coalesce(new.board_id, old.board_id);
begin
  update public.boards set revision = revision + 1 where id = target;
  return coalesce(new, old);
end;
$fn$;

-- ...for child rows that only know their card.
create or replace function public.board_bump_revision_by_card()
returns trigger language plpgsql as $fn$
declare
  target uuid;
begin
  select board_id into target from public.board_cards
   where id = coalesce(new.card_id, old.card_id);
  if target is not null then
    update public.boards set revision = revision + 1 where id = target;
  end if;
  return coalesce(new, old);
end;
$fn$;

-- ...and for checklist items, two hops from a card.
create or replace function public.board_bump_revision_by_checklist()
returns trigger language plpgsql as $fn$
declare
  target uuid;
begin
  select c.board_id into target
    from public.board_checklists cl
    join public.board_cards c on c.id = cl.card_id
   where cl.id = coalesce(new.checklist_id, old.checklist_id);
  if target is not null then
    update public.boards set revision = revision + 1 where id = target;
  end if;
  return coalesce(new, old);
end;
$fn$;

-- Attach the triggers. Written as a loop so adding a table later is one edit,
-- and every CREATE is preceded by a DROP so the whole file stays re-runnable.
do $do$
declare
  t text;
begin
  -- updated_at maintenance
  foreach t in array array[
    'boards','board_lists','board_cards','board_checklists',
    'board_checklist_items','board_card_comments'
  ] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format(
      'create trigger %I_touch before update on public.%I
         for each row execute function public.board_touch_updated_at()', t, t);
  end loop;

  -- revision bumps, grouped by how the row reaches its board
  foreach t in array array[
    'board_lists','board_cards','board_members','board_labels',
    'board_card_comments','board_card_attachments'
  ] loop
    execute format('drop trigger if exists %I_bump on public.%I', t, t);
    execute format(
      'create trigger %I_bump after insert or update or delete on public.%I
         for each row execute function public.board_bump_revision_by_board()', t, t);
  end loop;

  foreach t in array array['board_card_labels','board_card_members','board_checklists'] loop
    execute format('drop trigger if exists %I_bump on public.%I', t, t);
    execute format(
      'create trigger %I_bump after insert or update or delete on public.%I
         for each row execute function public.board_bump_revision_by_card()', t, t);
  end loop;

  execute 'drop trigger if exists board_checklist_items_bump on public.board_checklist_items';
  execute 'create trigger board_checklist_items_bump
             after insert or update or delete on public.board_checklist_items
             for each row execute function public.board_bump_revision_by_checklist()';
end;
$do$;

-- ===========================================================================
-- Atomic operations.
--
-- supabase-js cannot open a transaction — each .from(...) call is its own
-- statement. Anything that must not half-apply therefore lives here, in a
-- function, where Postgres gives us the transaction for free.
-- ===========================================================================

-- Create a board with its owner, starter columns and default label palette in
-- ONE transaction. Half of this succeeding (a board with no owner and no
-- columns) would be an unusable row the UI has no way to repair.
create or replace function public.board_create(
  p_name        text,
  p_description text,
  p_owner_name  text,
  p_theme       text default 'indigo',
  p_visibility  text default 'workspace',
  p_project_id  uuid default null,
  p_list_titles text[] default array['Ideas','To Do','In Progress','Review','Done'],
  p_labels      jsonb default '[{"name":"Priority","color":"rose"},{"name":"Design","color":"violet"},{"name":"Engineering","color":"indigo"},{"name":"Content","color":"cyan"},{"name":"Blocked","color":"amber"},{"name":"Done","color":"emerald"}]'::jsonb
) returns uuid
language plpgsql as $fn$
declare
  v_board uuid;
  v_owner uuid;
  v_title text;
  v_label jsonb;
  i int := 0;
begin
  insert into public.boards (name, description, theme, visibility, project_id)
  values (p_name, p_description, p_theme, p_visibility, p_project_id)
  returning id into v_board;

  insert into public.board_members (board_id, display_name, role, color)
  values (v_board, p_owner_name, 'owner', 'indigo')
  returning id into v_owner;

  update public.boards set owner_member_id = v_owner where id = v_board;

  -- Positions are spaced by BOARD_POSITION_STEP (65536, see
  -- lib/boards/position.ts) so there is room to insert between neighbours
  -- thousands of times before a normalize is needed.
  foreach v_title in array coalesce(p_list_titles, array[]::text[]) loop
    i := i + 1;
    insert into public.board_lists (board_id, title, position)
    values (v_board, v_title, i * 65536.0);
  end loop;

  i := 0;
  for v_label in select * from jsonb_array_elements(coalesce(p_labels, '[]'::jsonb)) loop
    i := i + 1;
    insert into public.board_labels (board_id, name, color, position)
    values (v_board, coalesce(v_label->>'name', ''), v_label->>'color', i * 65536.0);
  end loop;

  insert into public.board_activity (board_id, actor_member_id, action_type, metadata)
  values (v_board, v_owner, 'board.created', jsonb_build_object('name', p_name));

  return v_board;
end;
$fn$;

-- Move a card: reposition, optionally re-parent to another list, and record the
-- activity — atomically. A partial apply here is the worst case in the whole
-- feature: a card whose list_id moved but whose board_id did not would vanish
-- from the board it is on.
create or replace function public.board_move_card(
  p_card_id  uuid,
  p_list_id  uuid,
  p_position double precision,
  p_actor    uuid default null
) returns public.board_cards
language plpgsql as $fn$
declare
  v_card     public.board_cards;
  v_old_list uuid;
  v_board    uuid;
  v_from     text;
  v_to       text;
begin
  select * into v_card from public.board_cards where id = p_card_id for update;
  if not found then
    raise exception 'card_not_found' using errcode = 'P0002';
  end if;
  v_old_list := v_card.list_id;

  -- The destination list must exist AND belong to the same board. Without this
  -- check a crafted request could relocate a card into another board's column.
  select board_id into v_board from public.board_lists where id = p_list_id;
  if v_board is null or v_board <> v_card.board_id then
    raise exception 'list_not_on_board' using errcode = '22023';
  end if;

  update public.board_cards
     set list_id = p_list_id, position = p_position
   where id = p_card_id
  returning * into v_card;

  if v_old_list <> p_list_id then
    select title into v_from from public.board_lists where id = v_old_list;
    select title into v_to   from public.board_lists where id = p_list_id;
    insert into public.board_activity (board_id, card_id, actor_member_id, action_type, metadata)
    values (v_card.board_id, p_card_id, p_actor, 'card.moved',
            jsonb_build_object('fromListId', v_old_list, 'toListId', p_list_id,
                               'fromList', v_from, 'toList', v_to));
  end if;

  return v_card;
end;
$fn$;

-- Rewrite every position in a list as evenly spaced multiples of the step. Run
-- when repeated midpoint inserts have squeezed two neighbours to within the
-- precision floor of a double. One statement, so the board is never observed
-- half-renumbered.
create or replace function public.board_normalize_card_positions(p_list_id uuid)
returns void language sql as $fn$
  update public.board_cards c
     set position = r.rn * 65536.0
    from (
      select id, row_number() over (order by position, created_at) as rn
        from public.board_cards
       where list_id = p_list_id and archived_at is null
    ) r
   where c.id = r.id;
$fn$;

create or replace function public.board_normalize_list_positions(p_board_id uuid)
returns void language sql as $fn$
  update public.board_lists l
     set position = r.rn * 65536.0
    from (
      select id, row_number() over (order by position, created_at) as rn
        from public.board_lists
       where board_id = p_board_id and archived_at is null
    ) r
   where l.id = r.id;
$fn$;

-- ===========================================================================
-- Grants. `public` grants anon/authenticated/service_role by default for
-- TABLES, but functions created here still need an explicit grant for PostgREST
-- to expose them as RPCs.
-- ===========================================================================
grant execute on function public.board_create(text, text, text, text, text, uuid, text[], jsonb)
  to anon, authenticated, service_role;
grant execute on function public.board_move_card(uuid, uuid, double precision, uuid)
  to anon, authenticated, service_role;
grant execute on function public.board_normalize_card_positions(uuid)
  to anon, authenticated, service_role;
grant execute on function public.board_normalize_list_positions(uuid)
  to anon, authenticated, service_role;
