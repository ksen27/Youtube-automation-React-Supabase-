/**
 * Phase 2 — Video Selection.
 * Score = views*0.6 + comments*0.2 + likes*0.2, then take the top N.
 * Pure function so it is trivially unit-testable.
 */
export interface ScorableVideo {
  youtubeId: string;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
}

export function scoreVideo(v: ScorableVideo): number {
  return (v.viewCount ?? 0) * 0.6 + (v.commentCount ?? 0) * 0.2 + (v.likeCount ?? 0) * 0.2;
}

export function selectTopVideos<T extends ScorableVideo>(videos: T[], max: number): T[] {
  return [...videos].sort((a, b) => scoreVideo(b) - scoreVideo(a)).slice(0, max);
}
