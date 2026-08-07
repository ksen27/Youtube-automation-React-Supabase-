import { ValueObject } from '../shared/ValueObject';

interface ChapterResearchProps {
  chapterId: string;
  chapterTitle: string;
  relatedVideoIds: string[];
  supportingStories: string[];
  supportingLessons: string[];
  supportingExamples: string[];
  supportingCaseStudies: string[];
  supportingFrameworks: string[];
  supportingPrinciples: string[];
  audienceQuestions: string[];
  inputHash: string;
}

/**
 * Phase 10 output: the research package assembled for a single chapter.
 * This is the "no vector DB" retrieval result — relevant material is matched by
 * keyword/theme overlap (see ChapterResearch retrieval in the use case), not embeddings.
 */
export class ChapterResearch extends ValueObject<ChapterResearchProps> {
  static create(props: ChapterResearchProps): ChapterResearch {
    return new ChapterResearch(props);
  }
  get chapterId() {
    return this.props.chapterId;
  }
  get inputHash() {
    return this.props.inputHash;
  }
  toJSON(): ChapterResearchProps {
    return { ...this.props };
  }
  toText(): string {
    const block = (label: string, items: string[]) =>
      items.length ? `${label}:\n${items.map((i) => `- ${i}`).join('\n')}` : '';
    return [
      block('Supporting stories', this.props.supportingStories),
      block('Supporting lessons', this.props.supportingLessons),
      block('Supporting examples', this.props.supportingExamples),
      block('Supporting case studies', this.props.supportingCaseStudies),
      block('Supporting frameworks', this.props.supportingFrameworks),
      block('Supporting principles', this.props.supportingPrinciples),
      block('Audience questions to address', this.props.audienceQuestions),
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}
