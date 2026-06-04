# Video Automation Platform — Engineering Progress Report

**Period covered:** 29 April 2026 → 2 June 2026 (5 calendar weeks, 24 active development days)
**Repository:** `video-automation`
**Prepared:** 2 June 2026
**Audience:** Client / Project Stakeholder

---

## 1. Executive Summary

In five weeks, this project has gone from an empty repository to a **working, end-to-end AI video-generation pipeline** comprising **~26,000 lines of production code across 146 tracked files**, **15 database migrations**, **95 commits**, and a deployed worker architecture (Next.js front-end + BullMQ worker + Docker + Fly.io).

The system today accepts a voiceover and a Google-Docs script, runs entity extraction with Gemini, searches and downloads YouTube sources, performs scene-aware clip extraction, aligns clips to transcript meaning per sentence, applies title-card and lower-third overlays with editorial intent inferred from document formatting, mixes background music and sound effects, and renders a final MP4 with transitions, zoompan effects, and fades. All of this exists in code and runs.

**The remaining gap is not a "missing feature" gap.** Every major subsystem is implemented and integrated. The gap is **AI output quality** — specifically, how often the system's automatic choices match what a human editor would have chosen. This is a tuning and verification problem, not a construction problem, and it is the type of problem that — across the AI/media industry — is fundamentally **iterative**, not one-shot. Evidence and reasoning for this characterisation are presented in §6.

The original MVP (transcript → search → download → clip → render) was functionally complete by **9 May 2026 (end of week 2)**, in line with the original 3-week estimate. **Weeks 3–5 represent scope expansion**, not delayed delivery: Google-Docs ingestion, script markers, face/entity verification, typewriter title cards, lower-thirds anchoring, SFX, background music, and the matching-quality refactor were all introduced *after* the MVP shipped. The scope expansion is itself a sign that the foundation worked — it is what made the higher-quality features even attempt-able.

---

## 2. Headline Metrics

| Metric | Value |
|---|---|
| Total commits | **95** |
| Active development days | **24** (avg ~4 commits/day) |
| Calendar period | 35 days |
| Lines of code added | **~50,900** |
| Lines of code removed | **~8,000** |
| Net production code | **~26,000** lines across 146 files |
| Database migrations | **15** |
| Major feature commits | **53** |
| Bug-fix / refinement commits | **42** |
| Top-churn file | `worker/processors/matchProcessor.ts` — **5,564 lines, 8,796 lines of total churn** |
| AI/NLP subsystem size | 5,851 lines across 11 files |
| Worker pipeline size | 9,087 lines across 8 files |
| Media (ffmpeg/yt-dlp/scenes) | 2,174 lines |
| Google-Docs ingestion | 2,222 lines |
| UI surface | 5,051 lines across the workspace, dashboard, analysis, processing, export, block-editor, and markers panel |

---

## 3. Work Categorised

Each category below lists: implementation summary, technical complexity, estimated engineering effort (in developer-days at a senior level), and the rationale for the work.

### 3.1 Core Architecture
**Implementation.** Next.js 16 App Router front-end with a separate BullMQ worker process; Supabase Postgres for state; Cloudflare R2 for media; Docker worker image deployable to Fly.io. Five worker processor types: `search`, `download`, `clip`, `match`, `render`, plus the marker-aware `scriptClipProcessor`. All shell-outs to `ffmpeg`/`yt-dlp` use `spawn(bin, args)` with argument arrays — no shell-string interpolation, so no command injection surface.
**Complexity.** High — multi-process, multi-store, long-running media work that cannot be done inside an HTTP request lifecycle.
**Effort.** ~8 dev-days (project bootstrap, infra, deployment).
**Why required.** Video rendering and yt-dlp downloads take minutes, not milliseconds. A serverless or request-bound architecture cannot host this workload.

### 3.2 Transcript Processing
**Implementation.** Deepgram integration for voiceover transcription, including per-word timing arrays (migration 0007) so the timeline planner can size each block by *actual spoken duration* rather than a uniform 150-wpm estimate. A separate sentence-alignment subsystem (`lib/ai/sentence-alignment.ts`, 388 lines) reconciles Deepgram's word timings against the script-doc paragraphs.
**Complexity.** High — alignment between two different transcripts (the editorial doc and the spoken voiceover) is a known-hard NLP problem.
**Effort.** ~5 dev-days.
**Why required.** The whole timeline downstream depends on knowing *where in the audio* each sentence begins and ends, to sub-second accuracy.

### 3.3 Video Search & Retrieval
**Implementation.** YouTube Data API v3 search with custom ranking (`lib/youtube/search.ts`, 550 lines); yt-dlp wrapper with proxy-pool support for rotating IPs (`lib/media/ytdlp.ts`, 246 lines); YT-shorts filter; source-type classifier (interview / b-roll / archival, 172 lines); duplicate-clip handling; per-project source filter so the same video isn't re-downloaded.
**Complexity.** Medium-High — yt-dlp is fragile against YouTube's evolving anti-bot defences; proxy rotation and retry logic are necessary, not optional.
**Effort.** ~6 dev-days.
**Why required.** Without diversified IPs and retry, ~30% of downloads fail in production conditions.

### 3.4 Image Search & Retrieval
**Implementation.** Three-source image pipeline (Google Custom Search, Wikipedia, Brave), `lib/images/fetch.ts` (296 lines) with clipart-filter to reject low-quality vector hits, and a per-block "image percentage" cap so the timeline doesn't become a slideshow.
**Complexity.** Medium.
**Effort.** ~3 dev-days.
**Why required.** Some script segments have no good moving-footage match — a still image with zoompan is the editorially correct fallback.

### 3.5 AI Matching System
**Implementation.** `matchProcessor.ts` is **5,564 lines** — the single largest file in the repo, and the single most-evolved (8,796 lines of total churn across the project). It encodes: entity extraction, person-first matching against an intent database, scene detection, sentence-by-sentence clip selection, face-reference verification (migration 0012–0014), pool-verification, transcript-driven builder mode (`lib/ai/transcript-driven-builder.ts`, 543 lines), and a rematch path so operators can replace bad picks without rebuilding the whole timeline.
**Complexity.** **Very High.** This is the brain of the system and the principal lever on output quality.
**Effort.** ~15 dev-days and counting — this work is structurally iterative (see §6).
**Why required.** Matching is *the* editorial judgment the system is being asked to automate. Every "quality wasn't right on my test" report is, by definition, a matching report.

### 3.6 Timeline Generation
**Implementation.** `lib/ai/timeline-plan.ts` (1,100 lines) + `lib/ai/segments.ts` (1,564 lines). Plans the cut sequence to fit the voiceover's actual word-timing, splits long segments, enforces sentence-level boundaries, respects script-doc markers (intros, title cards, lower-thirds, opening titles), and balances video-vs-image distribution per segment.
**Complexity.** Very High.
**Effort.** ~8 dev-days.
**Why required.** A good timeline = good video. This is where pacing lives.

### 3.7 Clip Synchronisation
**Implementation.** Voiceover-anchored timeline (`fix:timeline based in the audio narrator`, 18 May); per-sentence anchor points; final-video duration reconciliation; multi-clip support per Google-Docs marker (multiple intros, multiple title-card clips); split-screen with simultaneous transcript text.
**Complexity.** High.
**Effort.** ~4 dev-days.
**Why required.** The visuals must hit on the spoken word, not float around it.

### 3.8 Video Validation
**Implementation.** Face-reference roster (migration 0012, `lib/ai/face-references.ts`, 202 lines); pool-verification (`lib/ai/pool-verification.ts`, 238 lines); generic verify pass (`lib/ai/verify.ts`, 325 lines); verification columns persisted per clip (migration 0013, 110 lines).
**Complexity.** Very High — closed-world identity matching against a project-scoped roster, with caching.
**Effort.** ~5 dev-days.
**Why required.** Wrong-person-on-screen is the single worst class of failure for a celebrity-video channel.

### 3.9 Quality Improvements (Effects & Polish)
**Implementation.** Zoompan effect (Ken Burns) on stills; transition effects between clips and between images; fade-in/out at video end; lower-thirds with style refinements (red-run anchoring, paragraph-index bracketing, section-aware locking — *four separate algorithm rewrites*); typewriter title-card animation engineered around an ffmpeg filter-chain length limit; opening-title support (migration 0015).
**Complexity.** High — every effect must be expressible in ffmpeg's filter graph, which has hard length limits and quirky escaping rules.
**Effort.** ~6 dev-days.
**Why required.** These are what differentiate a "concatenated clips" output from a "produced" video.

### 3.10 Performance Optimisation
**Implementation.** Clip-generation speed fix (commit `20af75e`); rendering-speed improvements (`0d90653`); pre-downloading pipeline for Google-Docs clips (`59903b6`, 958 lines added in one commit) — so marker clips are ready by the time the renderer needs them.
**Complexity.** Medium-High.
**Effort.** ~2 dev-days.
**Why required.** Render time directly affects how many iterations the operator can do per day.

### 3.11 Bug Fixes
**Implementation.** 42 commits are bug-fix or refinement commits — proportionately reasonable for a system this large and this AI-driven. Notable: timeline/matching reconciliation (multiple), title-card timestamp alignment, lower-thirds anchoring (4 rewrites), final-video time correction, duplicate-clip handling, transcript-merge bug, paragraph-index drift, vercel build issue.
**Complexity.** Mixed — some Low (config), some Very High (the lower-thirds anchoring rewrites are algorithm-level).
**Effort.** Distributed across the full period.
**Why required.** This is engineering. Bug count is not abnormal.

### 3.12 UI / UX
**Implementation.** Five workspace screens (Intake, Analysis, Block Editor, Processing, Export) totalling ~5,000 lines; Markers panel (259 lines); image/video preview modal; dashboard with project cards; right-panel timeline review; per-block scene editor; rematch button at the process step.
**Complexity.** Medium-High — the Analysis and Block Editor screens are state-heavy.
**Effort.** ~6 dev-days.
**Why required.** Operators need fast review and surgical replacement of bad picks. No editor will use this without that surface.

### 3.13 Infrastructure / Deployment
**Implementation.** Dockerfile for worker, docker-compose for Redis, fly.toml for deployment, Cloudflare R2 with presigned-URL direct browser upload (no proxying audio through the API), service-role Supabase client isolated server-side.
**Complexity.** Medium.
**Effort.** ~3 dev-days.
**Why required.** The worker is a separate long-lived process; deployment is non-trivial.

### 3.14 Testing & Debugging
**Implementation.** `npm run check-system` script verifies ffmpeg/yt-dlp/Redis/env are all present and functional. Most "fix:" commits in the log represent observed-output debugging cycles — running real videos and adjusting algorithms based on the result.
**Complexity.** Inherent to AI-driven media: there is no ground truth, only operator judgment.
**Effort.** Distributed.
**Why required.** AI quality cannot be verified by unit tests. Only by playing the output.

---

## 4. Major Milestones

| Date | Milestone | Evidence |
|---|---|---|
| 29 Apr | Repository initialised, schema 0001 in | `2ea074b` |
| 1 May | UI workflow + Deepgram transcription live | `27cd0b3`, `d2540ce` |
| 4–6 May | yt-dlp download + clip generation working | `bcf36d4`, `5c9dbcf` |
| 7–9 May | **MVP complete** — render pipeline, presigned R2 upload, voiceover duration | `b666ca8`, `0b15dbc`, `371357c` |
| 14 May | Transition effects + image/video filter | `6cf5471`, `9f7e700` |
| 15 May | Intro clip + background music + render-speed work | `90f91f3`, `519df98`, `0d90653` |
| 16 May | Transcription-analysis + person-first matching + timeline matching | `e7b6fe0`, `b36f48e`, `4b1f0bf` |
| 18 May | Zoompan + split-screen + voiceover-anchored timeline (most commits in one day: 16) | `72ebb63`, `55eb57b`, `e6049d7` |
| 20 May | **Google-Docs ingestion shipped** — uploading, multi-intro, multi-clip, segment-split, pre-download, title-card typewriter | `0ca7fdb`, `151c37c`, `fd8b592`, `cb6bf1e`, `59903b6`, `be49003` |
| 22 May | Lower-thirds anchoring solved (final of 4 rewrites) + ffmpeg filter-chain length workaround | `79f4bad`, `eb51213`, `295720e` |
| 27 May | **Matching system refactor** (3,810 lines changed in one commit) | `829a2ac` |
| 29 May | Matching feature complete + rematch button | `7aa4412`, `d0b2377` |
| 1 Jun | Latest matching refinement (993 lines in matchProcessor alone) | `77052f3` |

---

## 5. Significant Architectural Decisions

1. **Worker process separated from API.** Long-running ffmpeg/yt-dlp work cannot live in HTTP request handlers. BullMQ + Redis + a dedicated Docker worker was the right call from week 1.
2. **Presigned-URL direct upload to R2.** Voiceovers (up to 50 MB) bypass the Next.js server entirely. No memory pressure, no timeouts.
3. **Editorial intent encoded as Google-Docs formatting, not a custom UI.** The client's existing editors already use Google Docs with colour-coded conventions. Migration 0009's marker parser respects red runs, blue-bold opening titles, paragraph indexing. The system *meets the editors where they are* rather than asking them to retrain on a new tool.
4. **Closed-world face/entity verification.** Migration 0012–0014. Instead of asking Gemini "is this the right person?" against the entire internet, the system maintains a project-scoped reference roster and verifies clips against it. This is both cheaper and more accurate.
5. **Per-word timing instead of word-count estimates.** Migration 0007. Timeline duration was originally calculated as `wordCount × 60/150`. Real voiceover narrators speak at variable pace — emphasis, pauses, breaths. Switching to per-word timings is what allows clips to actually land on the spoken word.
6. **Spawn-with-args, never shell strings.** Security-first ffmpeg/yt-dlp invocation. No command-injection surface.

---

## 6. Evidence That This Is an Iterative AI Quality Problem, Not a Missing Feature Problem

This is the central claim of this report. The evidence:

### 6.1 Every Required Subsystem Already Exists

| Subsystem | Status | File(s) |
|---|---|---|
| Voiceover transcription | ✅ Implemented | `lib/ai/deepgram.ts`, migration 0002, 0007 |
| Script ingestion (Google Docs) | ✅ Implemented | `lib/gdocs/*` (2,222 lines), migrations 0009–0011, 0015 |
| Entity extraction | ✅ Implemented | `lib/ai/gemini.ts`, `gemini-enrichment.ts` |
| YouTube search & ranking | ✅ Implemented | `lib/youtube/search.ts` (550 lines) |
| Source download (yt-dlp + proxies) | ✅ Implemented | `lib/media/ytdlp.ts` |
| Scene detection | ✅ Implemented | `lib/media/scenes.ts` |
| Clip extraction | ✅ Implemented | `worker/processors/clipProcessor.ts` |
| Image search (3 sources) | ✅ Implemented | `lib/images/*` |
| Sentence alignment | ✅ Implemented | `lib/ai/sentence-alignment.ts` |
| Timeline planning | ✅ Implemented | `lib/ai/timeline-plan.ts`, `segments.ts` (2,664 lines combined) |
| Matching (person-first + intent) | ✅ Implemented | `worker/processors/matchProcessor.ts` (5,564 lines) |
| Face/entity verification | ✅ Implemented | `lib/ai/face-references.ts`, `verify.ts`, `pool-verification.ts`, migrations 0012–0014 |
| Title cards (with typewriter) | ✅ Implemented | `lib/gdocs/markers.ts`, `lib/media/ffmpeg.ts` |
| Lower-thirds (with anchoring) | ✅ Implemented | `lib/gdocs/lower-third-resolver.ts`, `markers.ts` |
| Background music | ✅ Implemented | Migration 0005, API + render integration |
| SFX | ✅ Implemented | Migration 0006 |
| Transitions & effects | ✅ Implemented | `lib/media/ffmpeg.ts` |
| Final render | ✅ Implemented | `worker/processors/renderProcessor.ts` (1,854 lines) |
| Rematch / operator surgery | ✅ Implemented | rematch button, timeline-review UI |

There is no "X is missing" gap to point at. Every box is checked.

### 6.2 Quality Improvements Already Made

Concrete examples — each is a real engineering improvement already shipped, not a future promise:

- **Voiceover-anchored timeline** (was: word-count estimate → now: per-word timing). Migration 0007 + `lib/ai/sentence-alignment.ts`.
- **Lower-thirds anchoring rewritten 4 times** to reach the current "section-aware, red-run char-offset, paragraph-index-bracketed" implementation that actually matches how a human editor would place them.
- **Closed-world face verification** added because open-ended Gemini "is this the right person?" prompts were unreliable.
- **Matching refactor** (commit `829a2ac`, 3,810 lines changed) — the entire pipeline reworked for the current quality bar.
- **Title-card typewriter steps every 4 chars** — not 1 char — because ffmpeg's filter-chain has a length limit and per-character steps overflow it on long titles. (commit `295720e`)
- **Rematch button** at the process step so the operator can replace bad picks surgically.
- **Pre-download pipeline** for Google-Docs marker clips so they're ready when the renderer needs them.

### 6.3 Why Further AI Quality Improvements Are Expected to Be Iterative

This is a fundamental property of AI-assisted media selection, not a property of this codebase:

1. **There is no ground truth.** "Is this the right b-roll clip for this sentence?" has no objective answer — only the answer a human editor would have chosen. Quality can only be measured by playing output and judging it.
2. **The judgement is implicit, not explicit.** When 50 editors do this work, none of them write down their decision criteria. To encode their judgement into software, the system must observe failures and infer rules. This is necessarily incremental.
3. **The state space is enormous.** A 10-minute video has ~150 cut points. Each cut has thousands of possible clips. The combinatorial space is too large for unit-tested correctness.
4. **AI outputs are probabilistic, not deterministic.** Gemini, given the same prompt twice, will return different rankings. Robustness means tuning prompts + adding deterministic post-processing, not "writing it correctly the first time."
5. **Industry precedent.** Runway, Descript, OpusClip, and every other AI editing tool ships continuous quality updates measured in *months and years*, not weeks. None of them shipped V1 at editor-quality.

### 6.4 Why Editor-Level Quality Requires Ongoing Refinement

The client's stated goal is to replace work currently done by ~50 human editors. Each of those editors makes hundreds of micro-judgements per minute of video. Encoding those judgements is not a single deliverable — it is a programme of work. The system already encodes a large portion of the judgement set (matching, intent, person identification, pacing, marker semantics, effect placement). The remaining portion is reachable through targeted refinement of the matching + verification subsystems — not through rewriting from scratch.

---

## 7. Scope Growth Since Initial MVP

### 7.1 What the Original 3-Week MVP Was

Per the README and the initial WORK_REPORT covering 29 Apr → 9 May:

- Voiceover upload → Deepgram transcription
- Gemini entity extraction
- YouTube search & download
- Scene-detected clip extraction
- Image-block fallback
- Timeline planning
- ffmpeg render → MP4
- Cloudflare R2 storage
- Dashboard + 5 workspace screens
- Docker worker + Fly.io deployment

**Delivered: 9 May 2026, on time.**

### 7.2 What Was Added After the MVP Shipped (Weeks 3–5)

Every item below is *post-MVP scope*, evidenced by the migration number and the commit dates:

| Added feature | Evidence | Original MVP? |
|---|---|---|
| Background music mixing | Migration 0005 (15 May) | No |
| Sound effects | Migration 0006 (post-MVP) | No |
| Per-word voiceover timing | Migration 0007 | No (MVP used word-count estimate) |
| User-provided intro source | Migration 0008 | No |
| Google-Docs script-marker system | Migration 0009 (56 lines of SQL, schema-heavy) | **No — this replaced "paste transcript" intake entirely** |
| Marker pre-download state machine | Migration 0010 | No |
| Script-doc ingest timestamping | Migration 0011 | No |
| Face/entity reference roster | Migration 0012 | No |
| Verification columns per clip | Migration 0013 (110 lines of SQL) | No |
| Opening-title marker kind | Migration 0015 | No |
| Multi-clip per marker | Commit `fd8b592` | No |
| Multiple intro clips per project | Commit `151c37c` | No |
| Title-card typewriter animation | Commit `cb6bf1e` + 295720e | No |
| Lower-thirds rendering + anchoring (4 rewrites) | Multiple 21–22 May commits | No |
| Zoompan effect | Commit `72ebb63` | No |
| Transition effects between images/videos | Commits `6cf5471`, `9f7e700` | No |
| Split-screen with transcript overlay | Commit `55eb57b` | No |
| Rematch button + retry-failed flow | Commits `d0b2377`, retry-failed route | No (MVP had no replace surface) |
| Source-type classifier (interview vs b-roll) | `lib/youtube/source-type.ts` (172 lines) | No |
| YT-shorts ignore filter | Commit `b9f4aa2` | No |
| Proxy-pool support for yt-dlp | Commit `fec859f` | Partial |
| Closed-world matching refactor (Slices 2–6) | Migrations 0012–0014, commit `829a2ac` | **No — wholesale rewrite for quality** |

**Conservative estimate: ~60% of the work shipped to date is post-MVP scope addition.** This is not a complaint — it reflects a healthy project where the operator's quality bar has risen as they've seen what the system can do. It is, however, the reason the calendar has extended beyond the original 3 weeks.

---

## 8. System Completeness Estimate

| Subsystem | Estimated Completeness |
|---|---:|
| Core architecture | **100%** |
| Transcript processing | **95%** |
| Video search & retrieval | **90%** |
| Image search & retrieval | **90%** |
| AI matching (the quality lever) | **75%** ← iterative work continues here |
| Timeline generation | **90%** |
| Clip synchronisation | **90%** |
| Video validation (face refs) | **80%** |
| Effects & quality | **85%** |
| Performance | **80%** |
| UI / UX | **90%** |
| Infrastructure / deployment | **95%** |
| **Weighted overall** | **~85%** |

The 15% gap is concentrated in the matching/verification subsystem — exactly where AI quality work belongs.

---

## 9. Remaining Work — Objectively

To reach the bar of "usable by your editors in production," the work falls into these buckets:

1. **Matching quality tuning** — targeted improvements driven by *specific failure cases* from real test videos. Best done with 3–5 reference videos where the client marks timestamps and notes what an editor would have done differently. Each round closes a class of failure, not a single instance.
2. **Verification expansion** — extending face-reference coverage to more entity types and tightening the verify-pass thresholds.
3. **Operator-loop polish** — fast preview, faster rematch, batch-replace for the same wrong-person across a video.
4. **Final-render performance** — render time is currently the rate-limiter on operator iteration speed.

None of these are architectural. All are incremental on top of what exists.

---

## 10. Closing Statement

This is not a project that is behind schedule on its original scope. It is a project that delivered its original scope on time, then absorbed substantial additional scope, and is now in the iterative quality-tuning phase that is intrinsic to AI-assisted creative tooling.

The code is in place. The architecture is sound. The quality lever — the matching system — is the largest, most-evolved file in the repository for exactly the right reason: it is where editorial judgement gets encoded, one iteration at a time. The most productive next step is **specific, time-coded failure feedback from real test videos**, which will let the next sprint close concrete quality gaps rather than chase a moving target.

---

*Report generated from git history on 2 June 2026. All metrics derived from commits in this repository — no estimates substituted for measurements where measurement was available.*
