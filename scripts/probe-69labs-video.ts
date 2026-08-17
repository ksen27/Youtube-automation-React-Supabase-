import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

// Discovery probe for 69labs' VIDEO api (the "videos" section of their
// dashboard, which carries a Veo 3 model). Nothing in the repo talks to it yet;
// this maps the contract — model catalogue + the submit/status/download paths —
// so lib/synthetic/ can be coded against real field names instead of guesses.
//
// Read-only: GETs only, no generation is submitted, nothing is billed.
//
//   npx tsx scripts/probe-69labs-video.ts

const BASE = (process.env.SIXTYNINE_LABS_BASE_URL || "https://69labs.vip").replace(/\/$/, "");
const KEY = (process.env.SIXTYNINE_LABS_API_KEY || "").trim();

async function get(path: string, { full = false } = {}) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    console.log(`\n[${res.status}] GET ${path}`);
    if (full) {
      try {
        console.log(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        console.log(text.slice(0, 4000));
      }
    } else {
      console.log(`  ${text.slice(0, 300).replace(/\n/g, "\n  ")}`);
    }
  } catch (e) {
    console.log(`\n[ERR] GET ${path} :: ${(e as Error).message}`);
  }
}

async function main() {
  if (!KEY) {
    console.error("SIXTYNINE_LABS_API_KEY not set");
    process.exit(2);
  }
  console.log(`Probing ${BASE} with key ${KEY.slice(0, 6)}…`);

  // The full video model catalogue — ids, credit costs, duration tiers,
  // aspect ratios, whether each takes an input image (image-to-video).
  await get("/api/v1/videos/models", { full: true });

  // Which submit/status/download paths exist. A 400/401/405 means the route is
  // REAL (it rejected the method/body); a 404 means it isn't there.
  for (const p of [
    "/api/v1/videos/generate",
    "/api/v1/videos/status/00000000-0000-0000-0000-000000000000",
    "/api/v1/videos/download/00000000-0000-0000-0000-000000000000",
  ]) {
    await get(p);
  }
}

void main();
