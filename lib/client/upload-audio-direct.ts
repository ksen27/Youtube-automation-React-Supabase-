// Two-step browser upload for bg music and SFX files. Bypasses Vercel's
// ~4.5MB request-body limit by uploading directly to Cloudflare R2 with a
// presigned URL, then notifying the API with just the storage key.
//
// Step 1: ask our API for a presigned PUT URL.
// Step 2: PUT the file body straight to R2 (no proxy through Vercel).
// Step 3: POST { storageKey, contentType } as JSON to the parent route so the
//         server records the resulting URL on the project row.
//
// Mirrors the pattern in upload-voiceover.ts. Kept separate because the
// voiceover flow returns transcription data we don't have here.

export type AudioUploadKind = "bg-music" | "sfx";

export interface AudioUploadResult {
  project: unknown;
}

export async function uploadAudioDirect(
  kind: AudioUploadKind,
  projectId: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<AudioUploadResult> {
  const contentType = file.type || "audio/mpeg";
  if (!contentType.startsWith("audio/")) {
    throw new Error("Selected file is not audio");
  }

  // 1) Presign
  const presignRes = await fetch(`/api/projects/${projectId}/${kind}/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentType,
      size: file.size,
    }),
  });
  if (!presignRes.ok) {
    throw new Error(await readError(presignRes, `Failed to get upload URL (${presignRes.status})`));
  }
  const { uploadUrl, storageKey } = (await presignRes.json()) as {
    uploadUrl: string;
    storageKey: string;
  };

  // 2) Upload directly to R2. XHR instead of fetch so we can report progress.
  await putToR2(uploadUrl, file, contentType, onProgress);

  // 3) Notify our API. Body is small (~few hundred bytes), so no edge limit.
  const notifyRes = await fetch(`/api/projects/${projectId}/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storageKey,
      contentType,
      filename: file.name,
    }),
  });
  if (!notifyRes.ok) {
    throw new Error(await readError(notifyRes, `Upload finalize failed (${notifyRes.status})`));
  }
  return (await notifyRes.json()) as AudioUploadResult;
}

// The platform-level 413 from Vercel returns plain text, not JSON, which
// breaks naive `(await r.json()).error` callers with "Unexpected token 'R'".
// Read as text first, then only JSON-parse when the body actually looks
// like JSON.
async function readError(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return fallback;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.error === "string") return parsed.error;
    } catch { /* fall through */ }
  }
  return trimmed.slice(0, 200) || fallback;
}

function putToR2(
  url: string,
  file: File,
  contentType: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", contentType);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`R2 upload failed (${xhr.status}): ${xhr.responseText.slice(0, 200)}`));
    };
    xhr.onerror = () => reject(new Error("R2 upload network error"));
    xhr.send(file);
  });
}
