import { describe, it, expect } from 'vitest';
import { TranscribeAudioUseCase } from './TranscribeAudioUseCase';
import { Result } from '../../domain/shared/Result';
import { Video } from '../../domain/video/Video';
import { VideoId } from '../../domain/video/VideoId';
import { Transcript } from '../../domain/video/Transcript';
import type { VideoRepository } from '../ports/repositories/VideoRepository';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { SpeechToText } from '../ports/services/SpeechToText';
import type { AudioDownloader, AudioDownloadTarget } from '../ports/services/AudioDownloader';
import type { RawTranscript } from '../ports/services/TranscriptProvider';
import type { Hasher } from '../ports/Hasher';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const VIDEO_ID = '22222222-2222-4222-8222-222222222222';
const YOUTUBE_ID = 'dQw4w9WgXcQ';
const JOB_REF = `${PROJECT_ID}/${VIDEO_ID}.mp3`;

const job = { projectId: PROJECT_ID, videoId: VIDEO_ID, audioRef: JOB_REF };

function video(withTranscript = false): Video {
  const v = Video.create({
    id: VideoId.from(VIDEO_ID),
    projectId: PROJECT_ID,
    youtubeId: YOUTUBE_ID,
    title: 'A video with no captions',
    description: null,
    publishedAt: null,
    durationSeconds: 600,
    viewCount: null,
    position: 0,
    hasAudio: true,
  });
  if (withTranscript) {
    v.attachTranscript(Transcript.fromYouTube({ language: 'en', text: 'captions', segments: [] }, 'h'));
  }
  return v;
}

class FakeVideoRepo implements VideoRepository {
  saves = 0;
  /** Set to simulate the transcript row failing to persist. */
  saveError: Error | null = null;
  constructor(private readonly stored: Video | null) {}
  async findById(id: VideoId): Promise<Video | null> {
    return this.stored && this.stored.id.value === id.value ? this.stored : null;
  }
  async findByProject(): Promise<Video[]> {
    return [];
  }
  async countByProject(): Promise<number> {
    return 0;
  }
  async save(): Promise<void> {
    this.saves += 1;
    if (this.saveError) throw this.saveError;
  }
  async saveMany(): Promise<void> {}
}

class FakeStorage implements ObjectStorage {
  removed: string[] = [];
  constructor(private readonly present: Set<string>) {}
  async put(): Promise<Result<{ path: string }>> {
    return Result.ok({ path: '' });
  }
  async signedUrl(): Promise<Result<string>> {
    return Result.ok('https://example.test/audio.mp3');
  }
  async getDataUri(): Promise<Result<string>> {
    return Result.fail('not used');
  }
  async getBytes(): Promise<Result<{ bytes: Uint8Array; contentType: string }>> {
    return Result.fail('not used');
  }
  async exists(_bucket: string, path: string): Promise<boolean> {
    return this.present.has(path);
  }
  async remove(_bucket: string, path: string): Promise<Result<void>> {
    this.removed.push(path);
    return Result.ok();
  }
}

class FakeStt implements SpeechToText {
  transcribed: string[] = [];
  async transcribe(audioRef: string): Promise<Result<RawTranscript>> {
    this.transcribed.push(audioRef);
    return Result.ok({ language: 'en', text: 'spoken words', segments: [] });
  }
}

class FakeDownloader implements AudioDownloader {
  calls: AudioDownloadTarget[] = [];
  constructor(private readonly outcome: Result<{ audioRef: string }>) {}
  async downloadAudio(target: AudioDownloadTarget): Promise<Result<{ audioRef: string }>> {
    this.calls.push(target);
    return this.outcome;
  }
}

const hasher: Hasher = { hash: () => 'hash' };
const rebuilt = Result.ok({ audioRef: JOB_REF });

function build(opts: {
  video?: Video | null;
  present?: string[];
  download?: Result<{ audioRef: string }>;
  saveError?: Error;
}) {
  const repo = new FakeVideoRepo(opts.video === undefined ? video() : opts.video);
  if (opts.saveError) repo.saveError = opts.saveError;
  const storage = new FakeStorage(new Set(opts.present ?? [JOB_REF]));
  const stt = new FakeStt();
  const audio = new FakeDownloader(opts.download ?? rebuilt);
  return { repo, storage, stt, audio, uc: new TranscribeAudioUseCase(repo, stt, storage, hasher, audio) };
}

describe('TranscribeAudioUseCase', () => {
  it('transcribes the job audio and cleans it up', async () => {
    const { uc, stt, storage, audio, repo } = build({});
    const r = await uc.execute(job);
    expect(r.isOk()).toBe(true);
    expect(stt.transcribed).toEqual([JOB_REF]);
    expect(storage.removed).toEqual([JOB_REF]);
    expect(repo.saves).toBe(1);
    expect(audio.calls).toHaveLength(0); // present → no re-download
  });

  // The reported failure: the audio object was gone by the time this stage ran,
  // so signing a URL for it returned "Object not found" — which no retry can
  // fix. Three attempts later the whole project was marked FAILED. Rebuild the
  // audio instead of failing.
  it('re-downloads audio that is no longer in storage, instead of failing', async () => {
    const { uc, stt, audio } = build({ present: [] });
    const r = await uc.execute(job);
    expect(r.isOk()).toBe(true);
    expect(audio.calls).toEqual([{ youtubeId: YOUTUBE_ID, projectId: PROJECT_ID, videoId: VIDEO_ID }]);
    expect(stt.transcribed).toEqual([JOB_REF]);
  });

  it('transcribes the rebuilt ref when the re-download lands on a different key', async () => {
    const fresh = `${PROJECT_ID}/${VIDEO_ID}-2.mp3`;
    const { uc, stt, storage } = build({ present: [], download: Result.ok({ audioRef: fresh }) });
    expect((await uc.execute(job)).isOk()).toBe(true);
    expect(stt.transcribed).toEqual([fresh]);
    expect(storage.removed).toEqual([fresh]); // cleans up what it actually used
  });

  it('fails (retryably) when the audio is gone and cannot be rebuilt', async () => {
    const { uc, stt, storage } = build({ present: [], download: Result.fail('yt-dlp exited 1') });
    const r = await uc.execute(job);
    if (!r.isFail()) throw new Error('expected a failure');
    expect(r.error).toMatch(/yt-dlp exited 1/);
    expect(stt.transcribed).toHaveLength(0);
    expect(storage.removed).toHaveLength(0);
  });

  // The audio is the only way to rebuild a Whisper transcript. Deleting it while
  // the transcript row failed to persist leaves the video permanently stuck:
  // no transcript to read, no audio to re-transcribe.
  it('keeps the audio when persisting the transcript fails', async () => {
    const { uc, storage } = build({ saveError: new Error('transcript save failed: timeout') });
    await expect(uc.execute(job)).rejects.toThrow(/transcript save failed/);
    expect(storage.removed).toHaveLength(0);
  });

  it('is a no-op for a video that already has a transcript', async () => {
    const { uc, stt, storage, audio } = build({ video: video(true), present: [] });
    expect((await uc.execute(job)).isOk()).toBe(true);
    expect(stt.transcribed).toHaveLength(0);
    expect(audio.calls).toHaveLength(0);
    expect(storage.removed).toHaveLength(0);
  });

  it('fails when the video row is missing', async () => {
    const { uc } = build({ video: null });
    const r = await uc.execute(job);
    if (!r.isFail()) throw new Error('expected a failure');
    expect(r.error).toBe('Video not found');
  });
});
