import { ValueObject } from '../shared/ValueObject';

interface ChannelSummaryProps {
  summary: string;
  topics: string[];
  audience: string;
  tone: string;
  inputHash: string;
}

/** The reduce-step output: the channel's themes feeding outline generation. */
export class ChannelSummary extends ValueObject<ChannelSummaryProps> {
  static create(props: ChannelSummaryProps): ChannelSummary {
    return new ChannelSummary(props);
  }
  get summary() {
    return this.props.summary;
  }
  get topics() {
    return this.props.topics;
  }
  get tone() {
    return this.props.tone;
  }
  get inputHash() {
    return this.props.inputHash;
  }
}
