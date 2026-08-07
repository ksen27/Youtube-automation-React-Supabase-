import Anthropic from '@anthropic-ai/sdk';
import { Result, type AiTextGenerator, type AiGenerateInput, type AiCompletion, type AiError, type AiContentBlock, type Telemetry } from '@ebook/core';
import { keepAliveAgent } from '../../net/keepAliveAgent';

/**
 * The only AI provider. Maps the Anthropic SDK to the AiTextGenerator port.
 * Prompt caching: when cacheControl.systemPrefix is set, the system block is
 * marked ephemeral so the shared context is reused across chapter generations.
 * Requests are streamed (.stream().finalMessage()) so long high-maxTokens
 * generations hold the connection open instead of risking an HTTP read timeout;
 * the awaited final message is identical to a non-streamed response.
 * Every successful call is reported to Telemetry (model, tokens, cost) when wired.
 */
export class ClaudeTextGenerator implements AiTextGenerator {
  constructor(
    private readonly client: Anthropic,
    private readonly telemetry?: Telemetry,
  ) {}

  static fromApiKey(apiKey: string, telemetry?: Telemetry): ClaudeTextGenerator {
    return new ClaudeTextGenerator(new Anthropic({ apiKey, httpAgent: keepAliveAgent }), telemetry);
  }

  async generate(input: AiGenerateInput): Promise<Result<AiCompletion, AiError>> {
    try {
      const system = input.cacheControl?.systemPrefix
        ? [{ type: 'text' as const, text: input.system, cache_control: { type: 'ephemeral' as const } }]
        : input.system;

      const response = await this.client.messages
        .stream({
          model: input.model,
          max_tokens: input.maxTokens,
          system,
          messages: input.messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : m.content.map(toAnthropicBlock),
          })),
          ...(input.metadata ? { metadata: { user_id: input.metadata.projectId } } : {}),
        })
        .finalMessage();

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      this.telemetry?.recordAiUsage({
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        ...(input.metadata?.stage ? { stage: input.metadata.stage } : {}),
        ...(input.metadata?.projectId ? { projectId: input.metadata.projectId } : {}),
      });

      return Result.ok({
        text,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        stopReason: response.stop_reason,
      });
    } catch (err) {
      return Result.fail(mapError(err));
    }
  }
}

function mapError(err: unknown): AiError {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 429) return { type: 'rate_limited' };
    if (err.status === 529) return { type: 'overloaded' };
    if (err.status === 400) return { type: 'invalid_request', message: err.message };
  }
  return { type: 'unknown', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Maps a port content block to the SDK's shape. Images travel as base64
 * source blocks; the port deliberately carries the payload without a `data:`
 * prefix because that is what the API expects.
 */
function toAnthropicBlock(block: AiContentBlock): Anthropic.TextBlockParam | Anthropic.ImageBlockParam {
  if (block.type === 'image') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: block.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
        data: block.dataBase64,
      },
    };
  }
  return { type: 'text', text: block.text };
}
