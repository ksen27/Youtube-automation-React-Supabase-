# Video Automation MVP

AI-assisted celebrity video generator. Paste a transcript → automatic YouTube research → clip extraction → draft timeline → manual review → final MP4 render.

## Stack

- **Frontend**: Next.js 16 App Router, TypeScript, Tailwind v4, shadcn-style UI primitives, React Hook Form + Zod, TanStack Query
- **Backend**: Next.js Route Handlers (Node runtime) + a separate BullMQ worker process in the same repo
- **Data**: Supabase Postgres + Supabase Storage
- **Jobs**: BullMQ on Redis
- **Media**: yt-dlp + FFmpeg / ffprobe (must be installed locally)
- **AI**: Google Gemini (`@google/generative-ai`)
- **Search**: YouTube Data API v3

> **Important:** Long-running yt-dlp / FFmpeg work always runs in the BullMQ worker, never in a request lifecycle.

## Prerequisites

You must install these binaries on the machine running the worker:

| Tool      | Install                                                     |
| --------- | ----------------------------------------------------------- |
| ffmpeg    | https://ffmpeg.org/download.html (also installs `ffprobe`)  |
| yt-dlp    | https://github.com/yt-dlp/yt-dlp/releases                   |
| Node 20.9+ | https://nodejs.org                                         |
| Redis     | `docker compose up -d redis` (or local install)             |

Run `npm run check-system` after installing to verify all binaries / connections.

## Setup

```bash
# 1) Install
npm install

# 2) Bring up Redis
docker compose up -d redis

# 3) Configure env
cp .env.example .env.local
#    fill in:
#      NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
#      YOUTUBE_API_KEY    (Google Cloud → enable "YouTube Data API v3")
#      GEMINI_API_KEY     (https://aistudio.google.com/app/apikey)

# 4) Create Supabase Storage bucket named "video-automation" (public).

# 5) Apply DB schema
#    Copy supabase/migrations/0001_init.sql into the Supabase SQL editor and run.
#    Or, if linked: supabase db push

# 6) System sanity check
npm run check-system
```

## Run

Two processes — **both must be running** for the pipeline to work.

```bash
# Terminal 1 — Next.js
npm run dev

# Terminal 2 — BullMQ worker
npm run worker
```

Open http://localhost:3000.

## End-to-end flow

1. **/dashboard** → click *Create project* (give it a title, optionally paste transcript).
2. On the project page, paste/save the transcript and (optionally) upload a voiceover.
3. Click **Start generation**. Pipeline kicks off:
   1. `search` job — Gemini extracts entities, queries YouTube, ranks candidates.
   2. `download` jobs — top 5 candidates downloaded with `yt-dlp` at ≤720p.
   3. `clip` jobs — up to 20 4–5s clips per source with FFmpeg, plus thumbnails. Uploaded to Supabase Storage.
   4. `\
   
4. Project status flips to `ready_for_review`. Use the **Timeline review** panel to reorder, replace, or remove items.
5. Click **Approve all** then **Start render**. The worker normalizes clips and concats them with FFmpeg, optionally mixes in voiceover, and uploads the final MP4.
6. Final video is previewable / downloadable on the project page.

Hard caps (configurable in `.env.local`):
- `MAX_VIDEOS_PER_PROJECT` — default 5
- `MAX_CLIPS_PER_VIDEO` — default 20
- `MAX_SOURCE_DURATION_SECONDS` — default 1500 (25 min)
- `WORKER_CONCURRENCY` — default 2
- `CLIP_OVERSAMPLING_FACTOR` — default 2 (clips per footage block; project-wide cap = `footageBlocks × oversampling`, bounded by `MIN_CLIP_CAP`/`MAX_CLIP_CAP`)
- `MIN_CLIP_CAP` / `MAX_CLIP_CAP` — defaults 20 / 400

## Scripts

| Command                | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `npm run dev`          | Start Next.js                                                  |
| `npm run worker`       | Start the BullMQ worker process                                |
| `npm run check-system` | Verify ffmpeg / yt-dlp / Redis / env keys                      |
| `npm run payhip:connect` | One-time headed login that stores the Payhip session (see below) |
| `npm run payhip:debug-list` | Watch one book being listed on Payhip in a visible browser |
| `npm run db:migrate`   | Prints instructions for applying the SQL migrations            |
| `npm run typecheck`    | `tsc --noEmit`                                                 |
| `npm run lint`         | ESLint                                                         |
| `npm run build`        | `next build` (production)                                      |

## Listing a book for sale (Payhip)

A finished ebook needs a buy link before its landing page can be published. That
link used to be made by hand: create the product on Payhip, upload the PDF, copy
the URL back into the settings form. The **Create product** button on the
landing-page card does all of it and fills the checkout field in for you.

Payhip publishes **no API for creating products** — their public API covers
coupons and license keys only — so this drives their real dashboard in a
headless browser (`packages/ebook-infra/integrations/payhip/`).

### One-time setup

```bash
# 1) Apply the migration that stores the session
#    supabase/migrations/0034_payhip_session.sql  (Supabase SQL editor)

# 2) Log in once, by hand, on a machine WITH a display
npm run payhip:connect
```

A visible browser opens. Log in to Payhip yourself — including any captcha, 2FA
or email code — and the session is captured and stored **encrypted** in the
database. Every headless worker then reuses it.

**Workers never log in.** A headless login walks straight into 2FA/captcha, and
giving a worker credentials means storing credentials on a worker. When the app
reports the session has expired, re-run `npm run payhip:connect`. There are
deliberately no Payhip username/password env vars.

The session lives in the database rather than in a file because the workers run
on Fly with ephemeral filesystems: a state file would not survive a deploy and
would never reach the worker that needs it, since the connect runs on your
laptop and the automation runs in a container. It also means there is no session
file on disk to commit by accident.

### Environment variables

All optional — the defaults are correct for a normal Payhip account.

| Variable             | Default                | Purpose                                                     |
| -------------------- | ---------------------- | ----------------------------------------------------------- |
| `PAYHIP_BASE_URL`    | `https://payhip.com`   | Override only to point at a staging host                     |
| `PAYHIP_TIMEOUT_MS`  | `45000`                | Per-action budget; uploads get their own 10-minute allowance |
| `PAYHIP_DEBUG_DIR`   | `/tmp/payhip-debug`    | Screenshots + HTML snapshots of failed runs land here        |
| `PAYHIP_TMP_DIR`     | OS temp dir            | Where upload files are staged before Playwright reads them   |
| `PAYHIP_HEADED`      | `false`                | Run the automation visibly. Local debugging only             |
| `PAYHIP_SLOWMO_MS`   | `0`                    | Slows a headed run so a human can watch it                   |

`SECRET_BOX_KEY` (already required for the HeyGen account pool) is what encrypts
the stored session.

### Watching it run

The button hands the work to the queue, which means a failure surfaces as a job
that simply didn't finish. To watch the real thing instead:

```bash
npm run payhip:debug-list <projectId>     # the UUID in /books/<projectId>
```

A visible browser opens and every step is printed with a running clock, so a
long pause is attributable to a named step rather than to "it hung":

```
  [  0s] launching the browser
  [  2s] opening the dashboard (checking the session is still valid)
  [  5s] checking whether "The Mechanic Bible" is already listed
  [  9s] opening the new digital product form
  [ 11s] filling in the title, description and price
  [ 12s] uploading The-Mechanic-Bible.pdf (38.4 MB) — this is the slow part
  [ 94s] uploading the cover image
  [ 97s] publishing and reading back the buy link
  [103s] done — https://payhip.com/b/AbC12
```

It runs the same use case, page object and selectors the worker runs, so what
you watch is the production flow. It needs no worker and no Redis.

**It creates a real product on your live storefront** — it is not a dry run. The
idempotency guard still applies, so a book that already has one prints the stored
link and creates nothing; `--force` overrides that. `--headless` gives you the
step log without a window taking over the screen.

### When it fails

Every failure captures a screenshot and an HTML snapshot of the page the browser
was looking at, into `PAYHIP_DEBUG_DIR`, and the paths are included in the error
the operator sees. Start there — "it timed out" is unactionable; "it timed out,
here is the page" is a bug report.

Payhip ships UI changes without notice, and the first symptom is a button that
times out. Every selector lives in one file (`PayhipProductPage.ts`) so the fix
is confined to it, and the `@e2e` test is what confirms a fix:

```bash
PAYHIP_E2E=1 npx vitest run packages/ebook-infra/integrations/payhip
```

It needs a connected session and the Playwright browsers installed, and it stops
short of publishing anything — creating a real listing on your live storefront
as a side effect of a test run would be worse than the bug it looks for.

### Docker / Playwright dependencies

Nothing to add: `Dockerfile.worker` already runs
`npx playwright install --with-deps chromium` for the HeyGen automation, and this
module uses the same browser and the same OS libraries. On a **new** host,
`--with-deps` is the part that matters — a bare `playwright install` leaves
Chromium unable to start on Debian slim, which surfaces as a launch failure on
the first listing rather than at build time.

## Layout

```
app/
  api/projects/...                # Route handlers — all Node runtime
  dashboard/                      # Project list + create form
  projects/[id]/                  # Workspace, clips view
  settings/                       # Connection health
components/
  ui/                             # shadcn-style primitives (Button, Card, Input, ...)
  sidebar.tsx
lib/
  ai/gemini.ts                    # Entity extraction + clip matching
  jobs/queue.ts                   # BullMQ queues + helpers
  jobs/db.ts                      # media_jobs row helpers
  media/ytdlp.ts                  # yt-dlp wrapper (spawn argv, no shell)
  media/ffmpeg.ts                 # cut, thumbnail, normalize, concat
  media/probe.ts                  # ffprobe → JSON
  storage.ts                      # Supabase Storage upload/download
  supabase/server.ts              # service-role client (server only)
  supabase/browser.ts             # anon client (client side)
  youtube/search.ts               # YouTube Data API v3 + ranking
  env.ts, types.ts, utils.ts
worker/
  index.ts                        # BullMQ Worker entry
  processors/
    searchProcessor.ts
    downloadProcessor.ts
    clipProcessor.ts
    matchProcessor.ts
    renderProcessor.ts
supabase/migrations/0001_init.sql
scripts/check-system.ts
docker-compose.yml
```

## Security notes

- `SUPABASE_SERVICE_ROLE_KEY` is **only ever** read from `lib/supabase/server.ts`. Never imported in client components.
- All shell-outs use `spawn(bin, args)` with argument arrays — no shell-string interpolation, so external IDs / titles / URLs cannot inject commands.
- All API inputs are validated with Zod.
- Voiceover upload is capped at 50MB and must be `audio/*`.
- Storage paths are constructed from sanitized IDs (`safeFilename`).

## What's intentionally not built (yet)

- Real transcription of uploaded voiceover (placeholder — current behavior just stores the audio URL).
- Drag-and-drop reorder (use the up/down arrows for now).
- Image search for `image` placeholder slots in the timeline (rendered as skipped clips for MVP).
- Auth / multi-user. `projects.user_id` is nullable.
