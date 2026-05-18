import { getEnv } from "@/lib/env";

// Deepgram prerecorded transcription via REST. We use raw fetch instead of the
// SDK to avoid an extra dependency — the surface we need is one POST.
// Docs: https://developers.deepgram.com/reference/listen-file

interface DeepgramWord {
  word: string;
  // Deepgram's smart_format=true returns a `punctuated_word` with the
  // sentence-end punctuation attached (e.g. "today." vs "today"). We use
  // it so sentence-boundary matching against the transcript works without
  // an extra punctuation-strip step.
  punctuated_word?: string;
  start: number;
  end: number;
  confidence?: number;
}
interface DeepgramAlternative {
  transcript: string;
  confidence: number;
  words?: DeepgramWord[];
}
interface DeepgramChannel {
  alternatives: DeepgramAlternative[];
}
interface DeepgramListenResponse {
  metadata?: { duration?: number };
  results?: { channels?: DeepgramChannel[] };
  err_msg?: string;
}

// Per-word timing surfaced to callers. Stored on projects.transcript_words
// so the timeline planner can size blocks to the narrator's real spoken
// duration for each sentence (eliminates the per-sentence drift introduced
// by the uniform-wpm estimator).
export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface TranscribeResult {
  transcript: string;
  // Audio duration in seconds, reported by Deepgram. Used as the primary
  // source of voiceover length on hosts where ffprobe isn't available
  // (e.g. Vercel's serverless Node runtime).
  durationSeconds: number | null;
  // Per-word timings in the order they appear in the transcript. May be
  // null on legacy callers that don't request them, but in practice every
  // current code path needs them for the timeline planner.
  words: WordTiming[] | null;
}

function buildListenUrl(): string {
  const env = getEnv();
  const params = new URLSearchParams({
    model: env.DEEPGRAM_MODEL,
    smart_format: "true",     // adds punctuation, capitalization, paragraphing
    punctuate: "true",
    detect_language: "true",  // auto-detect; pass language=xx to force
  });
  return `https://api.deepgram.com/v1/listen?${params}`;
}

function parseListenResponse(json: DeepgramListenResponse): TranscribeResult {
  const alt = json.results?.channels?.[0]?.alternatives?.[0];
  const transcript = alt?.transcript?.trim();
  if (!transcript) throw new Error("Deepgram returned no transcript");
  const dur = typeof json.metadata?.duration === "number" && json.metadata.duration > 0
    ? json.metadata.duration
    : null;
  // Prefer the punctuated form so sentence-boundary matching against the
  // smart-formatted transcript is straightforward. Fall back to the bare
  // word for safety, though current Deepgram models always emit both.
  const words: WordTiming[] | null = Array.isArray(alt?.words)
    ? alt!.words!.map((w) => ({
        word: w.punctuated_word ?? w.word,
        start: Number(w.start),
        end: Number(w.end),
      }))
    : null;
  return { transcript, durationSeconds: dur, words };
}

export async function transcribeAudio(buf: Buffer, mimeType: string): Promise<TranscribeResult> {
  const env = getEnv();
  if (!env.DEEPGRAM_API_KEY) throw new Error("DEEPGRAM_API_KEY not configured");

  const res = await fetch(buildListenUrl(), {
    method: "POST",
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      "Content-Type": mimeType || "application/octet-stream",
    },
    body: new Uint8Array(buf),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Deepgram ${res.status}: ${text.slice(0, 300) || res.statusText}`);
  }

  return parseListenResponse((await res.json()) as DeepgramListenResponse);
}

// URL-based transcription. Deepgram fetches the audio itself, which means our
// Vercel function never has to hold the bytes — critical for long voiceovers
// that would blow past Vercel's memory/timeout limits if we re-downloaded
// from R2 just to forward to Deepgram. The URL must be publicly fetchable
// (no auth headers can be passed through).
export async function transcribeAudioFromUrl(audioUrl: string): Promise<TranscribeResult> {
  const env = getEnv();
  if (!env.DEEPGRAM_API_KEY) throw new Error("DEEPGRAM_API_KEY not configured");

  const res = await fetch(buildListenUrl(), {
    method: "POST",
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: audioUrl }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Deepgram ${res.status}: ${text.slice(0, 300) || res.statusText}`);
  }

  return parseListenResponse((await res.json()) as DeepgramListenResponse);
}
