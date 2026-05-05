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
| `npm run db:migrate`   | Prints instructions for applying the SQL migrations            |
| `npm run typecheck`    | `tsc --noEmit`                                                 |
| `npm run lint`         | ESLint                                                         |
| `npm run build`        | `next build` (production)                                      |

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
