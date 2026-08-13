import { describe, it, expect } from 'vitest';
import { audioRefFor } from './YtDlpAudioDownloader';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '33333333-3333-4333-8333-333333333333';
const VIDEO_A = '22222222-2222-4222-8222-222222222222';
const VIDEO_B = '44444444-4444-4444-8444-444444444444';
const YOUTUBE_ID = 'dQw4w9WgXcQ';

describe('audioRefFor', () => {
  it('scopes the key to the project and video', () => {
    expect(audioRefFor({ youtubeId: YOUTUBE_ID, projectId: PROJECT_A, videoId: VIDEO_A })).toBe(
      `${PROJECT_A}/${VIDEO_A}.mp3`,
    );
  });

  // The original bug: the key was `<youtubeId>.mp3`, so every run of the same
  // video shared one object — and this stage DELETES the audio once transcribed.
  // A re-generate (or a second project on the same channel) deleted the file a
  // concurrent run still needed, which surfaced as "Object not found".
  it('gives two runs of the same youtube video distinct keys', () => {
    const a = audioRefFor({ youtubeId: YOUTUBE_ID, projectId: PROJECT_A, videoId: VIDEO_A });
    const b = audioRefFor({ youtubeId: YOUTUBE_ID, projectId: PROJECT_B, videoId: VIDEO_B });
    expect(a).not.toBe(b);
  });

  it('is stable for the same target, so a retry rebuilds the same key', () => {
    const target = { youtubeId: YOUTUBE_ID, projectId: PROJECT_A, videoId: VIDEO_A };
    expect(audioRefFor(target)).toBe(audioRefFor({ ...target }));
  });
});
