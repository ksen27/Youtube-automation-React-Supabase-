// Two-step browser upload for voiceover files. Bypasses Vercel's ~4.5MB
// request-body limit by uploading directly to R2 with a presigned URL,
// then notifying the API with just the storage key.
//
// Step 1: ask our API for a presigned PUT URL.
// Step 2: PUT the file body straight to R2 (no proxy through Vercel).
// Step 3: POST { storageKey, contentType } as JSON to /voiceover so the
//         server runs Deepgram against the now-public audio URL.

export interface UploadVoiceoverResult {
  project: unknown;
  voiceover_url: string;
  transcript: string;
  voiceover_duration_seconds: number | null;
}

export async function uploadVoiceoverDirect(
  projectId: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<UploadVoiceoverResult> {
  const contentType = file.type || "audio/mpeg";
  if (!contentType.startsWith("audio/")) {
    throw new Error("Selected file is not audio");
  }

  // 1) Presign
  const presignRes = await fetch(`/api/projects/${projectId}/voiceover/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentType,
      size: file.size,
    }),
  });
  if (!presignRes.ok) {
    const body = await presignRes.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to get upload URL (${presignRes.status})`);
  }
  const { uploadUrl, storageKey } = await presignRes.json();

  // 2) Upload directly to R2. We use XHR instead of fetch so we can report
  //    progress to the UI for big files.
  await putToR2(uploadUrl, file, contentType, onProgress);

  // 3) Notify our API. Body is small (~few hundred bytes), so no edge limit.
  const notifyRes = await fetch(`/api/projects/${projectId}/voiceover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storageKey,
      contentType,
      filename: file.name,
    }),
  });
  if (!notifyRes.ok) {
    const body = await notifyRes.json().catch(() => ({}));
    throw new Error(body.error ?? `Voiceover processing failed (${notifyRes.status})`);
  }
  return (await notifyRes.json()) as UploadVoiceoverResult;
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
