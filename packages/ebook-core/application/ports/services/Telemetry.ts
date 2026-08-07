/**
 * Observability sink for cost/usage metrics. Distinct from Logger (free-text
 * structured logs): Telemetry records quantitative events — AI token spend per
 * model/stage and stage durations — that feed billing and dashboards.
 */
export interface AiUsageEvent {
  model: string;
  inputTokens: number;
  outputTokens: number;
  stage?: string;
  projectId?: string;
}

export interface StageEvent {
  queue: string;
  projectId?: string;
  durationMs: number;
  outcome: 'completed' | 'failed';
}

export interface Telemetry {
  /** Record one Claude call. Implementations may estimate USD cost from the model. */
  recordAiUsage(event: AiUsageEvent): void;
  /** Record the outcome + duration of one queue job. */
  recordStage(event: StageEvent): void;
}
