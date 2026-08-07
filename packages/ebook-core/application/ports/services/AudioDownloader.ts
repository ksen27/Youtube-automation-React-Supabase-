import type { Result } from '../../../domain/shared/Result';

/** Downloads a video's audio track to object storage; returns the storage ref. */
export interface AudioDownloader {
  downloadAudio(youtubeId: string): Promise<Result<{ audioRef: string }>>;
}
