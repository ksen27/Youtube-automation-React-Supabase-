import { z } from 'zod';
import { Result } from '../../domain/shared/Result';
import { VideoId } from '../../domain/video/VideoId';
import { CommentInsights } from '../../domain/video/CommentInsights';
import type { VideoRepository } from '../ports/repositories/VideoRepository';
import type { KnowledgeRepository } from '../ports/repositories/KnowledgeRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { Hasher } from '../ports/Hasher';
import { CommentAnalysisPrompt } from '../prompts/CommentAnalysisPrompt';
import { parseJsonCompletion } from '../prompts/parse';
import type { VideoJob } from '../dto/jobs.dto';

const Schema = z.object({
  commonQuestions: z.array(z.string()),
  frustrations: z.array(z.string()),
  fears: z.array(z.string()),
  myths: z.array(z.string()),
  objections: z.array(z.string()),
  desiredResults: z.array(z.string()),
  recurringProblems: z.array(z.string()),
});

/** Phase 6 (Claude Haiku): mine audience psychology from a video's comments. */
export class AnalyzeCommentsUseCase {
  constructor(
    private readonly videos: VideoRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly ai: AiTextGenerator,
    private readonly hasher: Hasher,
  ) {}

  async execute(cmd: VideoJob): Promise<Result<void>> {
    const videoId = VideoId.from(cmd.videoId);
    const video = await this.videos.findById(videoId);
    if (!video) return Result.fail('Video not found');

    const comments = video.comments.map((c) => c.text);
    const inputHash = this.hasher.hash({ comments });

    const existing = await this.knowledge.getCommentInsights(videoId);
    if (existing?.inputHash === inputHash) return Result.ok(); // idempotent

    // No comments → store an empty insight so the barrier still advances.
    if (comments.length === 0) {
      await this.knowledge.saveCommentInsights(videoId, CommentInsights.empty(inputHash));
      return Result.ok();
    }

    const prompt = CommentAnalysisPrompt.build({ videoTitle: video.title, comments: comments.slice(0, 80) });
    const completion = await this.ai.generate({
      model: 'claude-haiku-4-5',
      // 7-array schema; too tight a budget truncates the JSON mid-object.
      // (Ceiling only — billed on actual output — so headroom is free insurance.)
      maxTokens: 4000,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      metadata: { projectId: cmd.projectId, stage: 'analyze-comments' },
    });
    // Transient provider errors stay fatal so the worker retries them.
    if (completion.isFail()) return Result.fail(completion.error.type);

    // A truncated or non-JSON response is a deterministic content failure that
    // won't change on retry. Persist empty insights so the per-video barrier
    // still converges (mirrors the no-comments path above) rather than stalling
    // the whole project on one video.
    const isTruncated = completion.value.stopReason === 'max_tokens';
    const parsed = isTruncated ? null : parseJsonCompletion(completion.value.text, Schema);
    if (isTruncated || !parsed || parsed.isFail()) {
      await this.knowledge.saveCommentInsights(videoId, CommentInsights.empty(inputHash));
      return Result.ok();
    }

    await this.knowledge.saveCommentInsights(videoId, CommentInsights.create({ ...parsed.value, inputHash }));
    return Result.ok();
  }
}
