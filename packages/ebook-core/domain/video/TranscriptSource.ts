export const TranscriptSource = {
  YOUTUBE: 'youtube',
  WHISPER: 'whisper',
} as const;

export type TranscriptSource = (typeof TranscriptSource)[keyof typeof TranscriptSource];
