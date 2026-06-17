# Synthetic Engine — Architecture & Implementation

A second video-generation engine added alongside the existing **sourced** engine
(download + edit real YouTube footage). The **synthetic** engine generates every
asset with AI: voiceover, images, animated clips, and avatar videos, then renders
a 1280×720 MP4 through the **existing** render pipeline.

> **Two products, one app.** The app exposes two top-level sidebar features:
> **Celebrity Videos** (sourced engine, `/dashboard`) and **AI Avatar**
> (synthetic engine, `/avatar`). Each dashboard lists only its own engine's
> projects; creating under `/avatar` always sets `engine = 'synthetic'`.
>
> **Invariant:** the sourced/celebrity engine is untouched. Everything synthetic
> is gated behind `projects.engine = 'synthetic'` (DB default `'sourced'`), lives
> on its own queues, and branches into its own workspace. No sourced code path
> changed behaviour — only additive `||`-clauses were added where the render
> route / processor must recognise the new block types.

---

## 1. Architecture diagram

```
                          ┌─────────────────────────────────────────────┐
   CREATE (engine=synthetic)                                             │
        │  title + engine                                                │
        ▼                                                                │
  ┌─────────────┐   intake: transcript / voiceover upload / avatar image │
  │  projects   │   POST /avatar-image, PATCH transcript, /voiceover     │
  └─────┬───────┘                                                        │
        │ POST /generate-synthetic                                       │
        ▼                                                                │
   ╔═══════════╗  ttsQueue (c=2)                                         │
   ║    TTS    ║  69labs TTS → master_voiceover.mp3 → R2                 │  REUSED
   ║ processor ║  Deepgram alignment (REUSED) → word/sentence timings    │  infra:
   ╚═════╤═════╝                                                         │  • BullMQ
         │ enqueue                                                       │  • Redis
         ▼                                                               │  • Deepgram
   ╔═══════════╗  syntheticPlannerQueue (c=2)                            │  • R2 storage
   ║  PLANNER  ║  Gemini → synthetic_segments[]                          │  • media_jobs
   ║ processor ║  (avatar | image | ai_clip | split_2)                   │  • render_jobs
   ╚═════╤═════╝  dispatchSegments() fans out per block_type             │  • renderProcessor
         │                                                               │  • ffmpeg helpers
   ┌─────┼──────────────┬───────────────────┐                           │
   ▼     ▼              ▼                   ▼                            │
 image  image        image_to_video      avatar (c=1)                   │
 _gen   _gen         Queue (c=2)          Queue                         │
 (c=3)  (split right)                                                   │
   │     │              │                   │                           │
 69labs  │         69labs img →         HeyGen (Playwright):            │
 nano-   │         fal.ai Veo3 Fast     • account rotation              │
 banana  │         → Kling fallback     • cookie sessions               │
 (Flux   │         (no audio)           • proxy support                 │
 fallbk) │                              • screenshots + retry           │
   └─────┴──────────────┴───────────────────┘                           │
         │ each → finishSegment(status: ready/failed)                    │
         ▼ maybeFinalizeSynthetic()                                      │
   ┌──────────────┐  materialize timeline_items (avatar/ai_clip/image/  │
   │ timeline_    │  split_2) → status = ready_for_review               │
   │ items        │                                                     │
   └──────┬───────┘                                                     │
         │  Review screen: regenerate / change type / edit / delete     │
         ▼  POST /render                                                 │
   ╔═══════════╗  renderQueue (REUSED, c=1)                              │
   ║  RENDER   ║  per-item: normalizeClip(avatar/ai_clip mp4),           │
   ║ processor ║  buildStillVideo(image), buildSplitScreenAvatarVideo    │◄┘
   ║ (REUSED)  ║  (split_2: avatar left + still right) → concat →
   ╚═════╤═════╝  mux master_voiceover → 1280×720 MP4 → R2
         ▼
   COMPLETED (download URL on render screen)
```

### Failure recovery / fallback chains
- **69labs image → Flux** (inside `generateImage`).
- **fal.ai Veo 3 Fast → Kling** (inside `generateClipWithFallback`).
- **ai_clip video fails → hold the generated still** (degrade, not fail).
- **HeyGen account fails → rotate to next account** (cooldown / disable past threshold).
- **BullMQ** retries every job (attempts=3, exp backoff). Only the final attempt
  marks a segment terminally failed, so the project can still finalize.
- **reconcile.ts sweep** (REUSED) reaps stalled synthetic media_jobs too.

---

## 2. Folder structure (new files)

```
supabase/migrations/
  0020_synthetic_engine.sql          # engine col, segment/heygen tables, block types

lib/
  types.ts                           # +Engine, +SyntheticSegment, +HeygenAccount, widened unions
  env.ts                             # +69labs/fal/HeyGen/SECRET_BOX_KEY/concurrency
  crypto/
    secret-box.ts                    # AES-256-GCM encrypt/decrypt for credentials+cookies
  jobs/queue.ts                      # +5 queues + enqueue helpers + job payloads
  synthetic/
    constants.ts                     # STYLE_PROMPT, canvas dims, R2 key layout
    http.ts                          # withHttpRetry + fetchOrThrow (transient-only retry)
    cost.ts                          # estimateCost + logProviderCall
    sixtynine-labs.ts                # generateVoice, generateImage (+Flux), listVoices
    falai.ts                         # generateVeoVideo, generateKlingVideo, fallback
    heygen-accounts.ts               # rotation/cooldown/encryption (pure, unit-tested)
    heygen.ts                        # Playwright automation (login/upload/generate/download)
    planner.ts                       # buildSyntheticTimeline (Gemini + word-timing align)
  media/ffmpeg.ts                    # +buildSplitScreenAvatarVideo

worker/
  index.ts                           # +5 workers wired with per-queue concurrency
  processors/synthetic/
    _shared.ts                       # queueForBlockType, dispatchSegments, maybeFinalizeSynthetic
    ttsProcessor.ts                  # STEP 2+3 voiceover + alignment
    plannerProcessor.ts              # STEP 4 planner + fan-out
    imageGenProcessor.ts             # image blocks
    imageToVideoProcessor.ts         # ai_clip blocks (still→video, degrade to still)
    avatarProcessor.ts               # avatar + split_2 (avatar video + right still)
  processors/renderProcessor.ts      # +synthetic branches (additive)

app/
  api/projects/route.ts              # +engine on create/list
  api/projects/[id]/generate-synthetic/route.ts
  api/projects/[id]/avatar-image/route.ts
  api/projects/[id]/synthetic/route.ts                       # live progress + segments
  api/projects/[id]/synthetic/segments/[segmentId]/route.ts  # PATCH/DELETE/POST(regen)
  api/projects/[id]/render/route.ts  # +synthetic renderable/duration-bearing types
  api/synthetic/voices/route.ts
  api/settings/heygen-accounts/route.ts
  avatar/page.tsx, avatar/new-avatar-form.tsx  # AI Avatar feature dashboard (synthetic only)
  dashboard/page.tsx                 # Celebrity Videos — filtered to sourced only
  projects/[id]/page.tsx             # route synthetic → SyntheticWorkspace
  projects/[id]/synthetic-workspace.tsx
  projects/[id]/_synthetic/{types,intake-screen,progress-screen,review-screen,render-screen}.tsx
  settings/{page,heygen-accounts}.tsx

scripts/test-synthetic.ts            # tsx unit tests (crypto/cost/proxy/style)
```

---

## Queue & concurrency table

| Queue                       | media_job type    | concurrency (env)              | provider |
|-----------------------------|-------------------|--------------------------------|----------|
| `tts`                       | `tts`             | `TTS_CONCURRENCY` (2)          | 69labs TTS + Deepgram |
| `syntheticPlanner`          | `plan_synthetic`  | `SYNTHETIC_PLANNER_CONCURRENCY` (2) | Gemini |
| `imageGeneration`           | `image_gen`       | `IMAGE_GEN_CONCURRENCY` (3)    | 69labs nano-banana / Flux |
| `imageToVideo`              | `image_to_video`  | `IMAGE_TO_VIDEO_CONCURRENCY` (2) | fal.ai Veo3 / Kling |
| `avatar`                    | `avatar`          | `AVATAR_CONCURRENCY` (1)       | HeyGen (Playwright) |

---

## Statuses (projects.status)

`created → voiceover → aligning → planning → generating_images →
generating_clips → generating_avatars → ready_for_review → rendering →
completed` (+ `failed`). The progress screen aggregates per-step from
`media_jobs` + `synthetic_segments`.

---

## Security

- HeyGen passwords + cookie/storage-state encrypted at rest with **AES-256-GCM**
  (`lib/crypto/secret-box.ts`, key `SECRET_BOX_KEY`). Plaintext never hits the DB.
- `listAccountsSafe()` returns status fields only — secrets never reach the frontend.
- All provider keys are server-only env, read through `getEnv()`; no
  `NEXT_PUBLIC_` exposure.

---

## 12. Implementation checklist

**Done (this change):**
- [x] Migration `0020_synthetic_engine.sql` (engine col, `synthetic_segments`, `heygen_accounts`, new block/job types)
- [x] Type definitions (`Engine`, `SyntheticSegment`, `HeygenAccount`, widened unions)
- [x] AES-256-GCM secret box + unit tests
- [x] Env config (69labs, Flux, fal.ai, HeyGen, `SECRET_BOX_KEY`, concurrency) + `.env.example`
- [x] 5 queues + enqueue helpers + payloads
- [x] Provider libs: 69labs (TTS+image+Flux fallback), fal.ai (Veo+Kling), HeyGen (Playwright)
- [x] Gemini planner with word-timing alignment
- [x] Cost tracking + structured provider logging
- [x] 5 worker processors + shared fan-out/finalize + worker wiring
- [x] API routes: generate-synthetic, avatar-image, synthetic status, segment CRUD/regen, voices, HeyGen accounts
- [x] `buildSplitScreenAvatarVideo` + render dispatch for avatar/ai_clip/split_2
- [x] UI: engine badge, engine selector, create-synthetic intake, progress, review, render, HeyGen settings
- [x] `tsc --noEmit` clean, eslint clean, unit tests green

**Operational follow-ups (before production):**
- [ ] Run migration `0020` against the database (Supabase SQL editor / `supabase db push`).
- [ ] Set provider secrets in env / Fly secrets: `SIXTYNINE_LABS_API_KEY`, `FAL_AI_API_KEY`, `FLUX_API_KEY` (optional), `SECRET_BOX_KEY` (`openssl rand -hex 32`), `HEYGEN_PROXIES`.
- [ ] `npx playwright install chromium` on the worker image (add to `Dockerfile.worker`).
- [ ] Add HeyGen accounts via Settings → HeyGen accounts.
- [ ] **Tune HeyGen selectors** in `lib/synthetic/heygen.ts` `SELECTORS` against the live DOM (login, upload, script, generate, download) — they are best-guess.
- [ ] Verify the actual 69labs / fal.ai request+response shapes against live docs; adjust the `buildBody`/`parse` blocks in `sixtynine-labs.ts` / `falai.ts` if they differ.
- [ ] Confirm `media-celebforge`-style R2 CORS allows the avatar-image fetch + video downloads the worker performs.
```
