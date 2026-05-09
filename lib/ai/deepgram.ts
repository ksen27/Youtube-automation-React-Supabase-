import { getEnv } from "@/lib/env";

// Deepgram prerecorded transcription via REST. We use raw fetch instead of the
// SDK to avoid an extra dependency — the surface we need is one POST.
// Docs: https://developers.deepgram.com/reference/listen-file

interface DeepgramAlternative {
  transcript: string;
  confidence: number;
}
interface DeepgramChannel {
  alternatives: DeepgramAlternative[];
}
interface DeepgramListenResponse {
  metadata?: { duration?: number };
  results?: { channels?: DeepgramChannel[] };
  err_msg?: string;
}

export interface TranscribeResult {
  transcript: string;
  // Audio duration in seconds, reported by Deepgram. Used as the primary
  // source of voiceover length on hosts where ffprobe isn't available
  // (e.g. Vercel's serverless Node runtime).
  durationSeconds: number | null;
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
  const transcript = json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
  if (!transcript) throw new Error("Deepgram returned no transcript");
  const dur = typeof json.metadata?.duration === "number" && json.metadata.duration > 0
    ? json.metadata.duration
    : null;
  return { transcript, durationSeconds: dur };
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
