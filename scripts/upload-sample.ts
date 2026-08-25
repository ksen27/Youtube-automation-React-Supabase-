// Upload a local sample clip to R2 and print its public URL.
//
//   npx tsx --env-file=.env.local <this file> <local-file> [dest-name]
//
// The pod serves finished clips at /files/{id}.mp4, but RESULT_TTL_SECONDS
// prunes them after an hour and the URL dies with the pod. A link that goes to a
// client needs to outlive both, so it goes to the same R2 bucket the renderer
// already publishes to.
import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const src = process.argv[2];
  if (!src) throw new Error("usage: upload-sample.ts <local-file> [dest-name]");
  const destName = process.argv[3] || path.basename(src);

  const { uploadBuffer } = await import("@/lib/storage");
  const buf = await fs.readFile(src);
  const ext = path.extname(src).toLowerCase();
  const contentType = ext === ".mp4" ? "video/mp4" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";

  // Namespaced under samples/ so these never collide with render output.
  const dest = `samples/clip-quality/${destName}`;
  const res = await uploadBuffer(buf, dest, contentType);
  console.log(`${destName}  ${(buf.length / 1048576).toFixed(2)} MB`);
  console.log(res.publicUrl);
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});
