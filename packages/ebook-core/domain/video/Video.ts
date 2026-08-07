import { AggregateRoot } from '../shared/AggregateRoot';
import { Result } from '../shared/Result';
import { VideoId } from './VideoId';
import { Transcript } from './Transcript';
import { TranscriptSource } from './TranscriptSource';
import { Comment } from './Comment';
import { VideoSummary } from './VideoSummary';

export type VideoContentStatus = 'PENDING' | 'GENERATING' | 'DONE' | 'FAILED';

interface VideoProps {
  projectId: string;
  youtubeId: string;
  title: string;
  description: string | null;
  publishedAt: Date | null;
  durationSeconds: number | null;
  viewCount: number | null;
  position: number;
  hasAudio: boolean;
  status: VideoContentStatus;
  transcript?: Transcript;
  comments: Comment[];
  summary?: VideoSummary;
}

export class Video extends AggregateRoot<VideoProps, VideoId> {
  static create(input: Omit<VideoProps, 'comments' | 'status'> & { id: VideoId }): Video {
    const { id, ...rest } = input;
    return new Video({ ...rest, comments: [], status: 'PENDING' }, id);
  }
  static rehydrate(props: VideoProps, id: VideoId): Video {
    return new Video(props, id);
  }

  get projectId() {
    return this.props.projectId;
  }
  get youtubeId() {
    return this.props.youtubeId;
  }
  get title() {
    return this.props.title;
  }
  get position() {
    return this.props.position;
  }
  get status(): VideoContentStatus {
    return this.props.status;
  }
  get transcript(): Transcript | undefined {
    return this.props.transcript;
  }
  get transcriptSource(): TranscriptSource | undefined {
    return this.props.transcript?.source;
  }
  get comments(): readonly Comment[] {
    return this.props.comments;
  }
  get summary(): VideoSummary | undefined {
    return this.props.summary;
  }

  hasTranscript(): boolean {
    return this.props.transcript !== undefined;
  }

  needsWhisperFallback(): boolean {
    return !this.hasTranscript() && this.props.hasAudio;
  }

  /** Invariant: never replace real captions with lower-fidelity Whisper output. */
  attachTranscript(transcript: Transcript): Result<void> {
    if (
      this.props.transcript?.source === TranscriptSource.YOUTUBE &&
      transcript.source === TranscriptSource.WHISPER
    ) {
      return Result.fail('Refusing to overwrite YouTube captions with Whisper output');
    }
    this.props.transcript = transcript;
    return Result.ok();
  }

  setComments(comments: Comment[]): void {
    this.props.comments = comments;
  }

  attachSummary(summary: VideoSummary): Result<void> {
    if (!this.props.transcript) return Result.fail('Cannot summarize a video without a transcript');
    this.props.summary = summary;
    this.props.status = 'DONE';
    return Result.ok();
  }

  markAwaitingTranscription(audioRef: string): void {
    this.props.status = 'GENERATING';
    // audioRef is persisted by the repository alongside the pending transcript intent
    delete this.props.transcript;
    this.props.pendingAudioRef = audioRef;
  }

  get pendingAudioRef(): string | undefined {
    return this.props.pendingAudioRef;
  }
}

// Augment props for the pending audio ref without polluting the public constructor signature.
interface VideoProps {
  pendingAudioRef?: string;
}
