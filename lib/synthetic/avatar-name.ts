import { createHash } from "node:crypto";

// The unique, deterministic name of THIS project's avatar for THIS source image:
// `va-<projectId8>-<imageSha6>`. Keying on the image hash (not just the project)
// makes split_2 automatic — its portrait-cropped bytes hash differently from the
// full-frame photo, so the two aspect variants get their own avatars — and any
// future multi-avatar-per-project feature inherits the same behavior. The `va-`
// prefix marks OUR machine-made avatars so cleanup can tell them from the
// account's human-made seed avatars (which must never be deleted — the composer
// is entered through them). Deterministic ⇒ every clip of the same project+image
// finds and REUSES the avatar created by the first clip on that account.
//
// Lives in its own module (not heygen.ts) because BOTH the browser flow
// (heygen.ts) and the API fallback (heygen-api.ts) derive the same name — the
// API fallback looks the avatar up by this exact name to reuse browser-created
// photo avatars — and heygen.ts already imports heygen-api.ts, so a value
// import back into heygen-api.ts would be circular.
export function projectAvatarName(projectId: string, imageBytes: Buffer): string {
  const proj = projectId.replace(/-/g, "").slice(0, 8).toLowerCase();
  const img = createHash("sha1").update(imageBytes).digest("hex").slice(0, 6);
  return `va-${proj}-${img}`;
}
