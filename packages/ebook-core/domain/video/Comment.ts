import { ValueObject } from '../shared/ValueObject';

interface CommentProps {
  youtubeId: string;
  author: string | null;
  text: string;
  likeCount: number;
  publishedAt: Date | null;
}

export class Comment extends ValueObject<CommentProps> {
  static create(props: CommentProps): Comment {
    return new Comment(props);
  }
  get text() {
    return this.props.text;
  }
  get likeCount() {
    return this.props.likeCount;
  }
}
