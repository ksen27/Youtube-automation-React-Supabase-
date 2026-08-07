import { ValueObject } from '../shared/ValueObject';

interface VideoSummaryProps {
  summary: string;
  keyLessons: string[];
  mistakes: string[];
  frameworks: string[];
  actionableTips: string[];
  successStories: string[];
  caseStudies: string[];
  audienceProblems: string[];
  audienceGoals: string[];
  recurringAdvice: string[];
  model: string;
  inputHash: string;
}

/**
 * Phase 5 output (Claude Sonnet): the structured knowledge extracted from one
 * video's transcript + comments. Named `VideoSummary` for continuity; the alias
 * `VideoKnowledge` matches logic.md.
 */
export class VideoSummary extends ValueObject<VideoSummaryProps> {
  static create(props: VideoSummaryProps): VideoSummary {
    return new VideoSummary(props);
  }
  toJSON(): VideoSummaryProps {
    return { ...this.props };
  }

  get summary() {
    return this.props.summary;
  }
  get keyLessons() {
    return this.props.keyLessons;
  }
  get frameworks() {
    return this.props.frameworks;
  }
  get caseStudies() {
    return this.props.caseStudies;
  }
  get successStories() {
    return this.props.successStories;
  }
  get audienceProblems() {
    return this.props.audienceProblems;
  }
  get audienceGoals() {
    return this.props.audienceGoals;
  }
  get recurringAdvice() {
    return this.props.recurringAdvice;
  }
  get inputHash() {
    return this.props.inputHash;
  }

  /** All extracted text concatenated — used for keyword retrieval (no vector DB). */
  searchableText(): string {
    return [
      this.props.summary,
      ...this.props.keyLessons,
      ...this.props.frameworks,
      ...this.props.caseStudies,
      ...this.props.successStories,
      ...this.props.recurringAdvice,
      ...this.props.audienceProblems,
      ...this.props.audienceGoals,
    ].join(' ');
  }

  /** Rich, prompt-friendly rendering for the knowledge base and chapter research. */
  toText(): string {
    const block = (label: string, items: string[]) => (items.length ? `${label}: ${items.join('; ')}` : '');
    return [
      `Summary: ${this.props.summary}`,
      block('Key lessons', this.props.keyLessons),
      block('Mistakes', this.props.mistakes),
      block('Frameworks', this.props.frameworks),
      block('Actionable tips', this.props.actionableTips),
      block('Success stories', this.props.successStories),
      block('Case studies', this.props.caseStudies),
      block('Audience problems', this.props.audienceProblems),
      block('Audience goals', this.props.audienceGoals),
      block('Recurring advice', this.props.recurringAdvice),
    ]
      .filter(Boolean)
      .join('\n');
  }
}

/** logic.md naming for the Phase 5 artifact. */
export type VideoKnowledge = VideoSummary;
