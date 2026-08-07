import { ValueObject } from '../shared/ValueObject';

interface CommentInsightsProps {
  commonQuestions: string[];
  frustrations: string[];
  fears: string[];
  myths: string[];
  objections: string[];
  desiredResults: string[];
  recurringProblems: string[];
  inputHash: string;
}

/** Phase 6 output (Claude Haiku): audience psychology mined from a video's comments. */
export class CommentInsights extends ValueObject<CommentInsightsProps> {
  static create(props: CommentInsightsProps): CommentInsights {
    return new CommentInsights(props);
  }
  static empty(inputHash: string): CommentInsights {
    return new CommentInsights({
      commonQuestions: [],
      frustrations: [],
      fears: [],
      myths: [],
      objections: [],
      desiredResults: [],
      recurringProblems: [],
      inputHash,
    });
  }
  get commonQuestions() {
    return this.props.commonQuestions;
  }
  get frustrations() {
    return this.props.frustrations;
  }
  get desiredResults() {
    return this.props.desiredResults;
  }
  get recurringProblems() {
    return this.props.recurringProblems;
  }
  /**
   * What stops this audience buying. Exposed for the landing copy, which is the
   * one place a page can answer an objection before it costs a sale — and which
   * has never seen this data despite the pipeline producing it since phase 6.
   */
  get objections() {
    return this.props.objections;
  }
  get inputHash() {
    return this.props.inputHash;
  }
  toJSON(): CommentInsightsProps {
    return { ...this.props };
  }
  /** Flatten to a compact text block for downstream prompts. */
  toText(): string {
    const lines: string[] = [];
    const add = (label: string, items: string[]) => {
      if (items.length) lines.push(`${label}: ${items.join('; ')}`);
    };
    add('Questions', this.props.commonQuestions);
    add('Frustrations', this.props.frustrations);
    add('Fears', this.props.fears);
    add('Myths', this.props.myths);
    add('Objections', this.props.objections);
    add('Desired results', this.props.desiredResults);
    add('Recurring problems', this.props.recurringProblems);
    return lines.join('\n');
  }
}
