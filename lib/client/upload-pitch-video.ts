// Two-step browser upload for the synthetic "sales pitch" video. Same shape as
// uploadVoiceoverDirect: presign -> PUT straight to R2 -> notify our API with
// just the storage key (the bytes never proxy through Vercel, so a large video
// sidesteps the ~4.5MB request-body limit).
//
// We read the video's duration in the browser (HTMLVideoElement.duration) and
// pass it to the notify call so the project knows how far the post-3:00 timeline
// will shift before the render worker re-probes the real file.

export interface UploadPitchVideoResult {
  project: unknown;
  pitch_video_url: string;
}

export async function uploadPitchVideoDirect(
  projectId: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<UploadPitchVideoResult> {
  const contentType = file.type || "video/mp4";
  if (!contentType.startsWith("video/")) {
    throw new Error("Selected file is not a video");
  }

  // Measure duration locally (best-effort — the worker re-probes the real file).
  const durationSeconds = await probeDurationSeconds(file).catch(() => undefined);

  // 1) Presign
  const presignRes = await fetch(`/api/projects/${projectId}/pitch-video/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, contentType, size: file.size }),
  });
  if (!presignRes.ok) {
    const body = await presignRes.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to get upload URL (${presignRes.status})`);
  }
  const { uploadUrl, storageKey } = await presignRes.json();

  // 2) Upload directly to R2 (XHR for progress reporting on big files).
  await putToR2(uploadUrl, file, contentType, onProgress);

  // 3) Notify our API (small JSON body).
  const notifyRes = await fetch(`/api/projects/${projectId}/pitch-video`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storageKey, contentType, filename: file.name, durationSeconds }),
  });
  if (!notifyRes.ok) {
    const body = await notifyRes.json().catch(() => ({}));
    throw new Error(body.error ?? `Pitch video processing failed (${notifyRes.status})`);
  }
  return (await notifyRes.json()) as UploadPitchVideoResult;
}

// Load the file into a hidden <video> just long enough to read its duration.
function probeDurationSeconds(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      const d = v.duration;
      URL.revokeObjectURL(url);
      if (Number.isFinite(d) && d > 0) resolve(d);
      else reject(new Error("could not read video duration"));
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not load video metadata"));
    };
    v.src = url;
  });
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
