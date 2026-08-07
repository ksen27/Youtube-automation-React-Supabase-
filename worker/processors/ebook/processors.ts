import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { ProjectJob, VideoJob, WhisperJob, ChapterResearchJob, ChapterJob, PolishChapterJob, ExportJob, ExtraContentJob, LandingPageJob, LandingTemplateJob, ExportFormat, ProjectId } from '@ebook/core';
import type { Container } from '@ebook/config';
import { makeWorker } from './runtime/worker-factory';
import { queueRuntimeConfig } from '@ebook/infra';

/**
 * Builds every stage worker for the full 15-phase pipeline. Each processor stays
 * thin: validate (schema in the factory) → call the use case → advance the
 * pipeline / report to the convergence barrier.
 */
export function buildWorkers(connection: Redis, container: Container): Worker[] {
  const { useCases, orchestrator } = container;

  const channelIngest = makeWorker(connection, container, {
    name: 'channel-ingest',
    ...queueRuntimeConfig('channel-ingest'),
    payloadSchema: ProjectJob,
    handler: async (p) => {
      const r = await useCases.ingestChannel.execute(p);
      if (r.isFail()) throw new Error(r.error);
      return r.value;
    },
  });

  const videoData = makeWorker(connection, container, {
    name: 'video-data',
    ...queueRuntimeConfig('video-data'),
    payloadSchema: VideoJob,
    handler: async (p) => {
      const r = await useCases.fetchVideoData.execute(p);
      if (r.isFail()) throw new Error(r.error);
    },
  });

  const transcriptFetch = makeWorker(connection, container, {
    name: 'transcript-fetch',
    ...queueRuntimeConfig('transcript-fetch'),
    payloadSchema: VideoJob,
    handler: async (p) => {
      const r = await useCases.fetchTranscript.execute(p);
      if (r.isFail()) throw new Error(r.error);
      // Transcript provenance: captions came straight from the YouTube Data API.
      // ('pending-whisper' is logged by the whisper worker once it transcribes.)
      if (r.value.outcome === 'youtube') {
        container.logger.info('📝 transcript source: YouTube Data API', { projectId: p.projectId, videoId: p.videoId, source: 'youtube-data-api' });
      }
      // Captions found (or already present) → summarize. 'pending-whisper'
      // continues via the whisper worker instead.
      if (r.value.outcome !== 'pending-whisper') {
        await enqueueSummarize(container, p.projectId, p.videoId);
      }
      return r.value;
    },
  });

  const whisper = makeWorker(connection, container, {
    name: 'whisper-transcribe',
    ...queueRuntimeConfig('whisper-transcribe'),
    payloadSchema: WhisperJob,
    handler: async (p) => {
      const r = await useCases.transcribeAudio.execute(p);
      if (r.isFail()) throw new Error(r.error);
      // Transcript provenance: no captions were available, so this was produced
      // by the Whisper audio-transcription fallback.
      container.logger.info('📝 transcript source: Whisper (audio fallback)', { projectId: p.projectId, videoId: p.videoId, source: 'whisper' });
      await enqueueSummarize(container, p.projectId, p.videoId);
    },
  });

  const videoSummarize = makeWorker(connection, container, {
    name: 'video-summarize',
    ...queueRuntimeConfig('video-summarize'),
    payloadSchema: VideoJob,
    handler: async (p) => {
      const r = await useCases.summarizeVideo.execute(p);
      if (r.isFail()) throw new Error(r.error);
      if (r.value.outcome === 'skipped-no-transcript') {
        container.logger.warn('video-summarize skipped — no transcript', { projectId: p.projectId, videoId: p.videoId });
      }
      if (r.value.outcome === 'skipped-summary-failed') {
        container.logger.warn('video-summarize skipped — unusable model output', {
          projectId: p.projectId,
          videoId: p.videoId,
          reason: r.value.reason,
        });
      }
      // Per-video chain continues into comment analysis (the last per-video step)
      // even when summarization was skipped, so the convergence barrier still
      // decrements for this video.
      await container.queue.enqueue(
        'analyze-comments',
        { projectId: p.projectId, videoId: p.videoId },
        { jobId: `analyze-comments:${p.projectId}:${p.videoId}` },
      );
    },
  });

  const analyzeComments = makeWorker(connection, container, {
    name: 'analyze-comments',
    ...queueRuntimeConfig('analyze-comments'),
    payloadSchema: VideoJob,
    handler: async (p) => {
      const r = await useCases.analyzeComments.execute(p);
      if (r.isFail()) throw new Error(r.error);
      // Convergence barrier for the entire per-video chain. The countdown counter
      // still drives the UI, but the advance decision is DB-authoritative: advance
      // when every video already has comment insights. That self-heals a drifted
      // counter (e.g. a decrement lost to a worker restart) that would otherwise
      // wedge the project forever on the per-video phase.
      const pid = ProjectId.from(p.projectId);
      const remaining = await container.repositories.projects.decrementPending(pid, 'VIDEO_PIPELINE');
      let converged = remaining <= 0;
      if (!converged) {
        const [analyzed, total] = await Promise.all([
          container.repositories.knowledge.countCommentInsights(pid),
          container.repositories.videos.countByProject(pid),
        ]);
        converged = total > 0 && analyzed >= total;
      }
      if (converged) await orchestrator.reachStage(p.projectId, 'BUILDING_KNOWLEDGE_BASE');
    },
  });

  const knowledgeBase = makeWorker(connection, container, {
    name: 'knowledge-base',
    ...queueRuntimeConfig('knowledge-base'),
    payloadSchema: ProjectJob,
    handler: async (p) => {
      const r = await useCases.buildKnowledgeBase.execute(p);
      if (r.isFail()) throw new Error(r.error);
      await orchestrator.advance(p.projectId, 'BUILDING_KNOWLEDGE_BASE');
    },
  });

  const bookStrategy = makeWorker(connection, container, {
    name: 'book-strategy',
    ...queueRuntimeConfig('book-strategy'),
    payloadSchema: ProjectJob,
    handler: async (p) => {
      const r = await useCases.generateBookStrategy.execute(p);
      if (r.isFail()) throw new Error(r.error);
      await orchestrator.advance(p.projectId, 'GENERATING_BOOK_STRATEGY');
    },
  });

  const outline = makeWorker(connection, container, {
    name: 'outline-generate',
    ...queueRuntimeConfig('outline-generate'),
    payloadSchema: ProjectJob,
    handler: async (p) => {
      // This use case materializes chapters, sets the chapter-research barrier,
      // advances to GENERATING_CHAPTER_RESEARCH and fans out the research jobs.
      const r = await useCases.generateOutline.execute(p);
      if (r.isFail()) throw new Error(r.error);
    },
  });

  const chapterResearch = makeWorker(connection, container, {
    name: 'chapter-research',
    ...queueRuntimeConfig('chapter-research'),
    payloadSchema: ChapterResearchJob,
    handler: async (p) => {
      const r = await useCases.generateChapterResearch.execute(p);
      if (r.isFail()) throw new Error(r.error);
      // Barrier: when every chapter has research, start chapter generation.
      const remaining = await container.repositories.projects.decrementPending(
        ProjectId.from(p.projectId),
        'GENERATING_CHAPTER_RESEARCH',
      );
      if (remaining <= 0) {
        const started = await useCases.startChapterGeneration.execute({ projectId: p.projectId });
        if (started.isFail()) throw new Error(started.error);
      }
    },
  });

  const chapterGenerate = makeWorker(connection, container, {
    name: 'chapter-generate',
    ...queueRuntimeConfig('chapter-generate'),
    payloadSchema: ChapterJob,
    handler: async (p) => {
      const r = await useCases.generateChapter.execute(p);
      if (r.isFail()) throw new Error(r.error);
      // Regeneration jobs are user-triggered and must not move the pipeline barrier.
      if (p.mode === 'generate') {
        await orchestrator.onStageItemCompleted(p.projectId, 'GENERATING_CHAPTERS');
      }
      return r.value;
    },
  });

  // Phase 12 controller — sets the polish fan-in barrier and fans out one
  // polish-chapter job per chapter. Does NOT advance; the barrier does.
  const polishBook = makeWorker(connection, container, {
    name: 'polish-book',
    ...queueRuntimeConfig('polish-book'),
    payloadSchema: ProjectJob,
    handler: async (p) => {
      const r = await useCases.startBookPolish.execute(p);
      if (r.isFail()) throw new Error(r.error);
      return r.value;
    },
  });

  const polishChapter = makeWorker(connection, container, {
    name: 'polish-chapter',
    ...queueRuntimeConfig('polish-chapter'),
    payloadSchema: PolishChapterJob,
    handler: async (p) => {
      const r = await useCases.polishChapter.execute(p);
      if (r.isFail()) throw new Error(r.error);
      // Barrier: when every chapter is polished, advance POLISHING_BOOK → ASSEMBLING.
      await orchestrator.onStageItemCompleted(p.projectId, 'POLISHING_BOOK');
      return r.value;
    },
  });

  // Phase 13 — async generation of a long-form extra-content unit (bonus chapter).
  // User-triggered: does NOT touch the pipeline barrier.
  const extraContent = makeWorker(connection, container, {
    name: 'extra-content',
    ...queueRuntimeConfig('extra-content'),
    payloadSchema: ExtraContentJob,
    handler: async (p) => {
      const r = await useCases.generateExtraContent.execute(p);
      if (r.isFail()) throw new Error(r.error);
      return r.value;
    },
  });

  const assemble = makeWorker(connection, container, {
    name: 'ebook-assemble',
    ...queueRuntimeConfig('ebook-assemble'),
    payloadSchema: ProjectJob,
    handler: async (p) => {
      // Give the book its publishing structure (Preface, Introduction, Conclusion),
      // its cover illustration, and its in-chapter illustrations before assembling.
      // All three are independent and STRICTLY best-effort — a thrown error (e.g. a
      // missing column before its migration runs) must degrade gracefully, never
      // abort assembly. allSettled keeps one failure from taking down the others.
      const [matterS, coverS, illustrationsS] = await Promise.allSettled([
        useCases.generateFrontBackMatter.execute(p),
        useCases.generateCoverImage.execute(p),
        useCases.generateIllustrations.execute(p),
      ]);

      if (matterS.status === 'rejected') {
        container.logger.warn('front/back matter generation threw; assembling without it', {
          projectId: p.projectId,
          error: String(matterS.reason),
        });
      } else if (matterS.value.isFail()) {
        container.logger.warn('front/back matter generation failed; assembling without it', {
          projectId: p.projectId,
          error: matterS.value.error,
        });
      }
      if (coverS.status === 'rejected') {
        container.logger.warn('cover image generation threw; using typographic cover', {
          projectId: p.projectId,
          error: String(coverS.reason),
        });
      } else if (coverS.value.isFail()) {
        container.logger.warn('cover image generation failed; using typographic cover', {
          projectId: p.projectId,
          error: coverS.value.error,
        });
      }
      if (illustrationsS.status === 'rejected') {
        container.logger.warn('illustration generation threw; assembling without illustrations', {
          projectId: p.projectId,
          error: String(illustrationsS.reason),
        });
      } else if (illustrationsS.value.isFail()) {
        container.logger.warn('illustration generation failed; assembling without illustrations', {
          projectId: p.projectId,
          error: illustrationsS.value.error,
        });
      } else {
        const { generated, attempted, error } = illustrationsS.value.value;
        if (attempted === 0) {
          // Nothing was even attempted — make the reason visible instead of silent:
          // either the option is off for this project or no chapter was eligible.
          container.logger.info('no illustrations attempted (feature off for this project or no eligible chapters)', {
            projectId: p.projectId,
          });
        }
        if (attempted > 0 && generated < attempted) {
          // Some/all images failed (e.g. 69labs error or out of credits). Surface
          // the first reason so an empty/short bucket is diagnosable, not silent.
          container.logger.warn('some in-chapter illustrations failed to generate', {
            projectId: p.projectId,
            generated,
            attempted,
            sampleError: error,
          });
        }
        if (generated > 0) {
          container.logger.info('🖼️  generated in-chapter illustrations', {
            projectId: p.projectId,
            generated,
            attempted,
          });
        }
      }
      const assembled = await useCases.assembleEbook.execute(p);
      if (assembled.isFail()) throw new Error(assembled.error);
      // Advance to EXPORTING; the orchestrator enqueues the export entry job.
      await orchestrator.advance(p.projectId, 'ASSEMBLING');
      return { chapters: assembled.value.chapters.length };
    },
  });

  const exportWorker = makeWorker(connection, container, {
    name: 'export',
    ...queueRuntimeConfig('export'),
    payloadSchema: ExportJob,
    handler: async (p) => {
      // Best-effort backfill: recover any recipe/chapter photos that failed image-gen
      // on the first assemble (e.g. 69labs rate limits left empty placeholder boxes).
      // generateIllustrations only fills MISSING photos and skips existing ones, so a
      // fully-illustrated book attempts nothing. Strictly non-fatal — a re-export must
      // never fail because image-gen is down.
      try {
        const backfill = await useCases.generateIllustrations.execute({ projectId: p.projectId });
        if (backfill.isOk() && backfill.value.generated > 0) {
          container.logger.info('🖼️  backfilled missing photos on re-export', {
            projectId: p.projectId,
            generated: backfill.value.generated,
            attempted: backfill.value.attempted,
          });
        } else if (backfill.isFail()) {
          container.logger.warn('photo backfill failed on re-export; exporting as-is', {
            projectId: p.projectId,
            error: backfill.error,
          });
        }
      } catch (err) {
        container.logger.warn('photo backfill threw on re-export; exporting as-is', {
          projectId: p.projectId,
          error: String(err),
        });
      }

      const assembled = await useCases.assembleEbook.execute({ projectId: p.projectId });
      if (assembled.isFail()) throw new Error(assembled.error);
      const formats =
        p.format === 'both' ? [ExportFormat.PDF, ExportFormat.DOCX] : [p.format === 'pdf' ? ExportFormat.PDF : ExportFormat.DOCX];
      // Each (re-)export lands at its own version so an edit-then-re-export writes a
      // NEW storage path (no stale-CDN read on an overwritten object) and the editor
      // can detect the fresh PDF by watching for a higher version.
      const bookVersion = (await container.repositories.artifacts.latestVersion(ProjectId.from(p.projectId))) + 1;
      const r = await useCases.exportEbook.execute({ projectId: p.projectId, doc: assembled.value, formats, bookVersion });
      if (r.isFail()) throw new Error(r.error);
      await orchestrator.advance(p.projectId, 'EXPORTING'); // → COMPLETED (no-op on a manual re-export)
      container.logger.info('📄 export complete', { projectId: p.projectId, bookVersion, formats: formats.length });

      // The sales page is NOT generated here. It is asked for from the project
      // page once the book exists, because that is the first moment the user
      // can have uploaded it to their store and have a checkout link to give.
      return r.value;
    },
  });

  /**
   * Phase 16 (optional) — the sales landing page. Post-pipeline and entirely
   * side-car: the project is already COMPLETED by the time this runs, so this
   * queue never touches the pipeline state machine or its barriers.
   */
  const landingPage = makeWorker(connection, container, {
    name: 'landing-page',
    ...queueRuntimeConfig('landing-page'),
    payloadSchema: LandingPageJob,
    handler: async (p) => {
      try {
        if (p.mode === 'generate') {
          // Which engine runs is decided by whether the project has a cloned
          // template, and it is reported rather than inferred. v1 chose between
          // two structurally unrelated renderers based on whether a layout
          // derivation happened to succeed, and said so only in this log.
          const project = await container.repositories.projects.findById(ProjectId.from(p.projectId));
          if (project?.options.landingEngine === 'clone') {
            const cloned = await useCases.generateClonedLandingPage.execute({
              projectId: p.projectId,
              force: true,
            });
            if (cloned.isFail()) throw new Error(cloned.error);
            const blockers = cloned.value.fidelity.findings.filter((f) => f.severity === 'BLOCKER');
            container.logger.info('🛒 cloned landing page ready', {
              projectId: p.projectId,
              engine: 'clone',
              template: project.options.landingTemplateId,
              // The number worth watching: how much of the page moved outside
              // the regions where content was replaced on purpose.
              drift: cloned.value.fidelity.visual.find((v) => v.width === 1280)?.mismatchRatio ?? null,
              blockers: blockers.length,
            });
            if (blockers.length > 0) {
              container.logger.warn('cloned page failed verification — it will not publish', {
                projectId: p.projectId,
                blockers: blockers.map((f) => `${f.code}: ${f.message}`),
              });
            }
            if (!p.publish) return cloned.value;
            const publishedClone = await useCases.publishLandingPage.execute({ projectId: p.projectId });
            if (publishedClone.isFail()) throw new Error(publishedClone.error);
            container.logger.info('🚀 landing page published', {
              projectId: p.projectId,
              url: publishedClone.value.url,
            });
            return publishedClone.value;
          }

          const generated = await useCases.generateLandingPage.execute({
            projectId: p.projectId,
            force: true,
            rebuildLayout: p.rebuildLayout,
          });
          if (generated.isFail()) throw new Error(generated.error);
          // Which layout was used is the number worth watching on early runs:
          // 'builtin' means the reference-driven generation failed the contract
          // twice and fell back, which is invisible from the page itself.
          container.logger.info('🛒 landing page draft ready', {
            projectId: p.projectId,
            layout: generated.value.layout ?? 'builtin',
            // Screenshots are what carry the reference's spacing and rhythm.
            // A run with 0 of them worked from markup alone and will look
            // measurably less like the template — invisible without this.
            reference: generated.value.referenceUrl ?? 'none',
            screenshots: generated.value.screenshots ?? 0,
            // A stored layout means no layout call ran at all — the difference
            // between a ~$0.15 page and a ~$2 one.
            layoutRebuilt: p.rebuildLayout === true,
          });
          if (generated.value.referenceNote) {
            container.logger.warn('reference was degraded — layout fidelity will suffer', {
              projectId: p.projectId,
              detail: generated.value.referenceNote,
            });
          }
          // A fallback is invisible on the page itself — it just looks plainer
          // than the reference. Put the exact rejections in the log so a
          // 'builtin' result is diagnosable instead of a mystery.
          // Accepted despite a visual complaint. Worth seeing — the reviewer
          // judges still images and is not always right — but NOT a fallback:
          // the page still follows the reference.
          if (generated.value.visualNotes) {
            container.logger.warn('reference layout shipped with visual notes', {
              projectId: p.projectId,
              notes: generated.value.visualNotes,
            });
          }
          if (generated.value.layoutFailure) {
            container.logger.warn('reference layout rejected — used the built-in template', {
              projectId: p.projectId,
              errors: generated.value.layoutFailure,
            });
          }
          if (!p.publish) return generated.value;
        }

        const published = await useCases.publishLandingPage.execute({ projectId: p.projectId });
        if (published.isFail()) throw new Error(published.error);
        container.logger.info('🚀 landing page published', { projectId: p.projectId, url: published.value.url });
        return published.value;
      } catch (err) {
        // The use cases record their own failures, but an unexpected throw (a
        // storage timeout, a bad row) would otherwise leave the page stuck
        // showing "generating" forever. Make every failure visible in the UI.
        await recordLandingFailure(container, p.projectId, err);
        throw err;
      }
    },
  });

  /**
   * Cloning a template site. Once per template, not once per book — and
   * deliberately its own queue, so a template that cannot be captured fails
   * visibly on its own row instead of taking a book's page down with it.
   */
  const landingTemplate = makeWorker(connection, container, {
    name: 'landing-template',
    ...queueRuntimeConfig('landing-template'),
    payloadSchema: LandingTemplateJob,
    handler: async (p) => {
      const extracted = await useCases.extractTemplate.execute({
        ownerId: p.ownerId,
        sourceUrl: p.sourceUrl,
        attestOwnership: true, // asserted at the API boundary and recorded there
        force: p.force,
        // The id the API already returned to the caller, so what they were
        // handed is what they can poll for.
        templateId: p.templateId,
      });
      if (extracted.isFail()) throw new Error(extracted.error);

      const report = extracted.value.report;
      container.logger.info('🧬 template extracted', {
        templateId: extracted.value.templateId,
        sourceUrl: p.sourceUrl,
        sections: report.sectionCount,
        // How much the page changed when its scripts were removed. This is the
        // honest cost of cloning, and the first number to look at when a page
        // comes back looking wrong.
        cleaningLoss: report.cleaningLoss.find((c) => c.width === 1280)?.mismatchRatio ?? null,
        fonts: report.fontFidelity,
        droppedImages: report.droppedImages.length,
        warnings: report.findings.filter((f) => f.severity === 'WARN').length,
      });
      for (const note of report.notes) {
        container.logger.warn('template extraction note', { templateId: extracted.value.templateId, note });
      }
      return extracted.value;
    },
  });

  return [
    channelIngest,
    videoData,
    transcriptFetch,
    whisper,
    videoSummarize,
    analyzeComments,
    knowledgeBase,
    bookStrategy,
    outline,
    chapterResearch,
    chapterGenerate,
    polishBook,
    polishChapter,
    extraContent,
    assemble,
    exportWorker,
    landingPage,
    landingTemplate,
  ];
}

/** Surface a landing-page failure on its own row, so the UI stops showing progress. */
async function recordLandingFailure(container: Container, projectId: string, err: unknown): Promise<void> {
  try {
    const page = await container.repositories.landingPages.findByProject(ProjectId.from(projectId));
    if (!page) return;
    page.markFailed(String(err instanceof Error ? err.message : err), container.clock.now());
    // State only — the failure handler must never be the thing that fails.
    await container.repositories.landingPages.saveState(page);
  } catch {
    /* best-effort */
  }
}

/** Enqueue the per-video summarize step (deterministic id → idempotent). */
async function enqueueSummarize(container: Container, projectId: string, videoId: string): Promise<void> {
  await container.queue.enqueue(
    'video-summarize',
    { projectId, videoId },
    { jobId: `video-summarize:${projectId}:${videoId}` },
  );
}
