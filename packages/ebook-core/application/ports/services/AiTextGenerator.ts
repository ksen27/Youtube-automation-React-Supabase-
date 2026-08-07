import type { Result } from '../../../domain/shared/Result';

export type ClaudeModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-8';

/**
 * An image sent alongside the prompt — currently the screenshots of the
 * reference sales page, which is the only way the model can see spacing,
 * rhythm and visual weight. Markup alone conveys structure, not look.
 */
export interface AiImageBlock {
  type: 'image';
  /** e.g. "image/png". */
  mediaType: string;
  /** Base64 payload WITHOUT the `data:` URI prefix. */
  dataBase64: string;
}

export interface AiTextBlock {
  type: 'text';
  text: string;
}

export type AiContentBlock = AiTextBlock | AiImageBlock;

export interface AiMessage {
  role: 'user' | 'assistant';
  /** A plain string for text-only calls, or blocks when images are attached. */
  content: string | AiContentBlock[];
}

export interface AiCompletion {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export interface AiGenerateInput {
  model: ClaudeModel;
  system: string;
  messages: AiMessage[];
  maxTokens: number;
  /** Mark the system prefix as cacheable so shared context is reused across calls. */
  cacheControl?: { systemPrefix?: boolean };
  metadata?: { projectId: string; stage: string };
}

export type AiError =
  | { type: 'rate_limited'; retryAfterMs?: number }
  | { type: 'overloaded' }
  | { type: 'invalid_request'; message: string }
  | { type: 'unknown'; message: string };

/** The only AI provider abstraction. Implemented by ClaudeTextGenerator. */
export interface AiTextGenerator {
  generate(input: AiGenerateInput): Promise<Result<AiCompletion, AiError>>;
}
