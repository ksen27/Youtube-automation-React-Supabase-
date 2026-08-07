import { describe, it, expect } from 'vitest';
import { scoreVideo, selectTopVideos } from './VideoSelection';

describe('VideoSelection (logic.md Phase 2)', () => {
  it('scores views*0.6 + comments*0.2 + likes*0.2', () => {
    expect(scoreVideo({ youtubeId: 'a', viewCount: 1000, commentCount: 100, likeCount: 200 })).toBe(
      1000 * 0.6 + 100 * 0.2 + 200 * 0.2,
    );
  });

  it('treats null stats as zero', () => {
    expect(scoreVideo({ youtubeId: 'a', viewCount: null, commentCount: null, likeCount: null })).toBe(0);
  });

  it('selects the top N by descending score', () => {
    const videos = [
      { youtubeId: 'low', viewCount: 10, commentCount: 0, likeCount: 0 },
      { youtubeId: 'high', viewCount: 10_000, commentCount: 500, likeCount: 800 },
      { youtubeId: 'mid', viewCount: 1000, commentCount: 50, likeCount: 100 },
    ];
    const top = selectTopVideos(videos, 2);
    expect(top.map((v) => v.youtubeId)).toEqual(['high', 'mid']);
  });

  it('does not mutate the input array', () => {
    const videos = [
      { youtubeId: 'a', viewCount: 1, commentCount: 0, likeCount: 0 },
      { youtubeId: 'b', viewCount: 2, commentCount: 0, likeCount: 0 },
    ];
    selectTopVideos(videos, 1);
    expect(videos.map((v) => v.youtubeId)).toEqual(['a', 'b']);
  });
});
