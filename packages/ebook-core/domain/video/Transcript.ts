import { ValueObject } from '../shared/ValueObject';
import { TranscriptSource } from './TranscriptSource';

export interface TranscriptSegment {
  start: number;
  duration: number;
  text: string;
}

interface TranscriptProps {
  source: TranscriptSource;
  language: string | null;
  text: string;
  segments: TranscriptSegment[];
  audioRef: string | null;
  inputHash: string;
}

export class Transcript extends ValueObject<TranscriptProps> {
  static fromYouTube(
    data: { language: string | null; text: string; segments: TranscriptSegment[] },
    inputHash: string,
  ): Transcript {
    return new Transcript({
      source: TranscriptSource.YOUTUBE,
      language: data.language,
      text: data.text,
      segments: data.segments,
      audioRef: null,
      inputHash,
    });
  }

  static fromWhisper(
    data: { language: string | null; text: string; segments: TranscriptSegment[]; audioRef: string },
    inputHash: string,
  ): Transcript {
    return new Transcript({
      source: TranscriptSource.WHISPER,
      language: data.language,
      text: data.text,
      segments: data.segments,
      audioRef: data.audioRef,
      inputHash,
    });
  }

  get source() {
    return this.props.source;
  }
  get text() {
    return this.props.text;
  }
  get segments() {
    return this.props.segments;
  }
  get inputHash() {
    return this.props.inputHash;
  }
}
