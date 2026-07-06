import { NextResponse, type NextRequest } from "next/server";
import { uploadBuffer } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Upload a REFERENCE thumbnail image for the /thumbnails feature. Returns its
// public R2 URL so the client can pass it to the generate route alongside any
// YouTube-URL references. Small images -> direct multipart upload (well under
// the ~4.5MB body limit), same as the synthetic avatar-image upload.
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing file" }, { status: 400 });
  if (!file.type.startsWith("image/")) return NextResponse.json({ error: "must be image/*" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "image too large (max 10MB)" }, { status: 413 });

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 6) || "jpg";
  const key = `thumbnails/references/${Date.now()}-${buf.length}.${ext}`;
  const up = await uploadBuffer(buf, key, file.type || "image/jpeg");

  return NextResponse.json({ url: up.publicUrl }, { status: 200 });
}
