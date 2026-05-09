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

export async function transcribeAudio(buf: Buffer, mimeType: string): Promise<TranscribeResult> {
  const env = getEnv();
  if (!env.DEEPGRAM_API_KEY) throw new Error("DEEPGRAM_API_KEY not configured");

  const params = new URLSearchParams({
    model: env.DEEPGRAM_MODEL,
    smart_format: "true",     // adds punctuation, capitalization, paragraphing
    punctuate: "true",
    detect_language: "true",  // auto-detect; pass language=xx to force
  });

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
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

  const json = (await res.json()) as DeepgramListenResponse;
  const transcript = json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
  if (!transcript) throw new Error("Deepgram returned no transcript");
  const dur = typeof json.metadata?.duration === "number" && json.metadata.duration > 0
    ? json.metadata.duration
    : null;
  return { transcript, durationSeconds: dur };
}
