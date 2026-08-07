import type { Logger, Telemetry, AiUsageEvent, StageEvent } from '@ebook/core';

interface TokenPrice {
  input: number;
  output: number;
}

/** USD per 1M tokens, by Claude model. Estimates — adjust to your contracted rate. */
const DEFAULT_PRICE: TokenPrice = { input: 3, output: 15 };
const PRICE_PER_MTOK: Record<string, TokenPrice> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-8': { input: 15, output: 75 },
};

/**
 * Telemetry sink that emits structured metric lines through the Logger and keeps
 * a running in-process cost tally. A production deployment would also push these
 * to a usage table / metrics backend; the Logger output is the portable default.
 */
export class PinoTelemetry implements Telemetry {
  private totalCostUsd = 0;

  constructor(private readonly logger: Logger) {}

  recordAiUsage(event: AiUsageEvent): void {
    const costUsd = estimateCost(event.model, event.inputTokens, event.outputTokens);
    this.totalCostUsd += costUsd;
    this.logger.info('ai.usage', {
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      costUsd: round4(costUsd),
      cumulativeCostUsd: round4(this.totalCostUsd),
      ...(event.stage ? { stage: event.stage } : {}),
      ...(event.projectId ? { projectId: event.projectId } : {}),
    });
  }

  recordStage(event: StageEvent): void {
    this.logger.info('stage.metric', {
      queue: event.queue,
      durationMs: event.durationMs,
      outcome: event.outcome,
      ...(event.projectId ? { projectId: event.projectId } : {}),
    });
  }
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICE_PER_MTOK[model] ?? DEFAULT_PRICE;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
