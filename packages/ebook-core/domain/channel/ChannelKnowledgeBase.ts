import { ValueObject } from '../shared/ValueObject';

interface ChannelKnowledgeBaseProps {
  coreThemes: string[];
  corePrinciples: string[];
  recurringAdvice: string[];
  commonMistakes: string[];
  audiencePainPoints: string[];
  audienceGoals: string[];
  transformationJourney: string;
  expertPositioning: string;
  hiddenInsights: string[];
  inputHash: string;
}

/** Phase 7 output (Claude Sonnet): the synthesized knowledge base for the whole channel. */
export class ChannelKnowledgeBase extends ValueObject<ChannelKnowledgeBaseProps> {
  static create(props: ChannelKnowledgeBaseProps): ChannelKnowledgeBase {
    return new ChannelKnowledgeBase(props);
  }
  get coreThemes() {
    return this.props.coreThemes;
  }
  get corePrinciples() {
    return this.props.corePrinciples;
  }
  get audiencePainPoints() {
    return this.props.audiencePainPoints;
  }
  get audienceGoals() {
    return this.props.audienceGoals;
  }
  get transformationJourney() {
    return this.props.transformationJourney;
  }
  get inputHash() {
    return this.props.inputHash;
  }
  toJSON(): ChannelKnowledgeBaseProps {
    return { ...this.props };
  }
  /** Compact, prompt-friendly rendering used as shared context downstream. */
  toText(): string {
    return [
      `Core themes: ${this.props.coreThemes.join('; ')}`,
      `Core principles: ${this.props.corePrinciples.join('; ')}`,
      `Recurring advice: ${this.props.recurringAdvice.join('; ')}`,
      `Common mistakes: ${this.props.commonMistakes.join('; ')}`,
      `Audience pain points: ${this.props.audiencePainPoints.join('; ')}`,
      `Audience goals: ${this.props.audienceGoals.join('; ')}`,
      `Transformation journey: ${this.props.transformationJourney}`,
      `Expert positioning: ${this.props.expertPositioning}`,
      `Hidden insights: ${this.props.hiddenInsights.join('; ')}`,
    ].join('\n');
  }
}
