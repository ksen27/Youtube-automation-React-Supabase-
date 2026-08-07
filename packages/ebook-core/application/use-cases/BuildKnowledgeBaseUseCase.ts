import { z } from 'zod';
import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { ChannelKnowledgeBase } from '../../domain/channel/ChannelKnowledgeBase';
import type { ChannelRepository } from '../ports/repositories/ChannelRepository';
import type { KnowledgeRepository } from '../ports/repositories/KnowledgeRepository';
import type { AiTextGenerator } from '../ports/services/AiTextGenerator';
import type { Hasher } from '../ports/Hasher';
import { KnowledgeBasePrompt } from '../prompts/KnowledgeBasePrompt';
import { parseJsonCompletion } from '../prompts/parse';
import type { ProjectJob } from '../dto/jobs.dto';

/**
 * Claude occasionally returns a list field as a single string instead of an
 * array. Coerce a lone string (or null) into a string[] so a benign shape
 * drift doesn't fail the whole job.
 */
const stringArray = z.preprocess(
  (v) => (typeof v === 'string' ? [v] : v == null ? [] : v),
  z.array(z.string()),
);

const Schema = z.object({
  coreThemes: stringArray,
  corePrinciples: stringArray,
  recurringAdvice: stringArray,
  commonMistakes: stringArray,
  audiencePainPoints: stringArray,
  audienceGoals: stringArray,
  transformationJourney: z.string(),
  expertPositioning: z.string(),
  hiddenInsights: stringArray,
});

/** Phase 7 (Claude Sonnet): reduce video knowledge + comment insights into a knowledge base. */
export class BuildKnowledgeBaseUseCase {
  constructor(
    private readonly channels: ChannelRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly ai: AiTextGenerator,
    private readonly hasher: Hasher,
  ) {}

  async execute(cmd: ProjectJob): Promise<Result<void>> {
    const projectId = ProjectId.from(cmd.projectId);
    const summaries = await this.channels.listVideoSummaries(projectId);
    if (summaries.length === 0) return Result.fail('No video summaries available');
    const insights = await this.knowledge.listCommentInsights(projectId);

    const inputHash = this.hasher.hash({
      s: summaries.map((s) => s.inputHash).sort(),
      c: insights.map((i) => i.inputHash).sort(),
    });
    const existing = await this.knowledge.getKnowledgeBase(projectId);
    if (existing?.inputHash === inputHash) return Result.ok(); // idempotent

    const channel = await this.channels.getChannel(projectId);
    const prompt = KnowledgeBasePrompt.build({
      channelTitle: channel?.title ?? 'Unknown channel',
      videoSummaries: summaries.map((s) => s.toText()),
      commentInsights: insights.map((i) => i.toText()).filter(Boolean),
    });
    const completion = await this.ai.generate({
      model: 'claude-sonnet-4-6',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      // The knowledge base is a large multi-field JSON synthesis; 2500 truncated
      // it mid-object, producing invalid JSON the parser rejected.
      maxTokens: 8000,
      cacheControl: { systemPrefix: true },
      metadata: { projectId: cmd.projectId, stage: 'knowledge-base' },
    });
    if (completion.isFail()) return Result.fail(completion.error.type);

    const parsed = parseJsonCompletion(completion.value.text, Schema);
    if (parsed.isFail()) return Result.fail(parsed.error);

    await this.knowledge.saveKnowledgeBase(projectId, ChannelKnowledgeBase.create({ ...parsed.value, inputHash }));
    return Result.ok();
  }
}
