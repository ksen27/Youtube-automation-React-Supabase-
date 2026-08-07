import { ValueObject } from '../shared/ValueObject';

interface ChannelProps {
  youtubeId: string;
  title: string;
  description: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  thumbnailUrl: string | null;
}

/** Immutable snapshot of a channel captured at ingestion time. */
export class Channel extends ValueObject<ChannelProps> {
  static create(props: ChannelProps): Channel {
    return new Channel(props);
  }
  get youtubeId() {
    return this.props.youtubeId;
  }
  get title() {
    return this.props.title;
  }
  get description() {
    return this.props.description;
  }
  get subscriberCount() {
    return this.props.subscriberCount;
  }
  /** The channel avatar — the landing page uses it as the brand mark. */
  get thumbnailUrl() {
    return this.props.thumbnailUrl;
  }
}
