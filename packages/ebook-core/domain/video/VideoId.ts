import { Identifier } from '../shared/Identifier';

export class VideoId extends Identifier {
  static from(value: string): VideoId {
    return new VideoId(value);
  }
}
