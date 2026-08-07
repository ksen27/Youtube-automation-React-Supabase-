import { Result } from '../../domain/shared/Result';
import { VideoId } from '../../domain/video/VideoId';
import { VideoSummary } from '../../domain/video/VideoSummary';
import type { VideoRepository } from '../ports/repositories/VideoRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { Hasher } from '../ports/Hasher';
import { VideoSummaryPrompt } from '../prompts/VideoSummaryPrompt';
import { parseJsonCompletion } from '../prompts/parse';
import { z } from 'zod';
import type { VideoJob } from '../dto/jobs.dto';

const SummarySchema = z.object({
  summary: z.string(),
  keyLessons: z.array(z.string()),
  mistakes: z.array(z.string()),
  frameworks: z.array(z.string()),
  actionableTips: z.array(z.string()),
  successStories: z.array(z.string()),
  caseStudies: z.array(z.string()),
  audienceProblems: z.array(z.string()),
  audienceGoals: z.array(z.string()),
  recurringAdvice: z.array(z.string()),
});

/**
 * Outcome of a summarize attempt.
 * - `summarized` — a structured summary was produced and attached.
 * - `skipped-no-transcript` — the video has no captions/Whisper text to summarize.
 * - `skipped-summary-failed` — the model returned an unusable response (truncated
 *   or non-JSON). This is a CONTENT failure that won't change on retry, so it's
 *   non-fatal: the per-video chain continues and the book is built from the rest.
 *   (Transient AI errors — rate limits/overload — still fail so BullMQ retries.)
 */
export type SummarizeOutcome =
  | { outcome: 'summarized' }
  | { outcome: 'skipped-no-transcript' }
  | { outcome: 'skipped-summary-failed'; reason: string };

// The 10-field schema (summary + nine arrays) needs headroom; too low a budget
// truncates the model mid-object and the closing brace is never emitted, yielding
// "No JSON object found in completion".
const SUMMARY_MAX_TOKENS = 6000;

/** Map step: per-video summary via Claude Haiku (fast/cheap structured extraction). */
export class SummarizeVideoUseCase {
  constructor(
    private readonly videos: VideoRepository,
    private readonly ai: AiTextGenerator,
    private readonly hasher: Hasher,
  ) {}

  async execute(cmd: VideoJob): Promise<Result<SummarizeOutcome>> {
    const video = await this.videos.findById(VideoId.from(cmd.videoId));
    if (!video) return Result.fail('Video not found');
    // A video with no captions and no Whisper transcript can't be summarized.
    // That's an expected outcome for some videos, not a pipeline error — skip it
    // so the per-video chain still converges and the book is built from the rest.
    if (!video.transcript) return Result.ok({ outcome: 'skipped-no-transcript' });

    const inputHash = this.hasher.hash({
      transcript: video.transcript.inputHash,
      comments: video.comments.map((c) => c.text),
    });
    if (video.summary?.inputHash === inputHash) return Result.ok({ outcome: 'summarized' }); // idempotent

    const prompt = VideoSummaryPrompt.build({
      title: video.title,
      transcript: video.transcript.text,
      comments: video.comments.map((c) => c.text).slice(0, 50),
    });
    const completion = await this.ai.generate({
      model: 'claude-haiku-4-5',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      maxTokens: SUMMARY_MAX_TOKENS,
      // The system block is identical for every video, so caching it turns each
      // per-video call into a cache read across the fan-out (same project, well
      // within the 5-min TTL).
      cacheControl: { systemPrefix: true },
      metadata: { projectId: cmd.projectId, stage: 'video-summarize' },
    });
    // Transient provider errors (rate-limited/overloaded/unknown) stay fatal so the
    // worker throws and BullMQ retries with backoff.
    if (completion.isFail()) return Result.fail(completion.error.type);

    // Truncated output can never contain the closing brace → skip non-fatally
    // rather than retry the same too-large request forever.
    if (completion.value.stopReason === 'max_tokens') {
      return Result.ok({ outcome: 'skipped-summary-failed', reason: 'completion truncated at max_tokens' });
    }

    const parsed = parseJsonCompletion(completion.value.text, SummarySchema);
    // A non-JSON / schema-mismatched response is a deterministic content failure;
    // retrying the same input won't help, so skip this video instead of stalling.
    if (parsed.isFail()) return Result.ok({ outcome: 'skipped-summary-failed', reason: parsed.error });

    const attach = video.attachSummary(
      VideoSummary.create({ ...parsed.value, model: completion.value.model, inputHash }),
    );
    if (attach.isFail()) return Result.fail(attach.error);
    await this.videos.save(video);
    return Result.ok({ outcome: 'summarized' });
  }
}
