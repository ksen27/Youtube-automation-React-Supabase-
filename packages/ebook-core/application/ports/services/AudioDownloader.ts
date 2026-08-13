import type { Result } from '../../../domain/shared/Result';

/**
 * Which video's audio to fetch, and for which run.
 *
 * The project/video pair is what SCOPES the stored object. Keying audio by
 * youtube id alone put every run of the same video on one storage key, and the
 * Whisper stage deletes its audio once transcribed — so a second run (a
 * re-generate, or another project on the same channel) would delete the file a
 * concurrent run was still waiting to transcribe.
 */
export interface AudioDownloadTarget {
  youtubeId: string;
  projectId: string;
  videoId: string;
}

/** Downloads a video's audio track to object storage; returns the storage ref. */
export interface AudioDownloader {
  downloadAudio(target: AudioDownloadTarget): Promise<Result<{ audioRef: string }>>;
}
