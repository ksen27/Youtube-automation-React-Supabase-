import { NextResponse } from "next/server";
import { isSixtyNineConfigured } from "@/lib/synthetic/sixtynine-labs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 69labs has no public voice-catalog endpoint in the documented API — voices
// are referenced by a specific voiceId (e.g. the client's Gr7mLjPA3HhuWxZidxPW),
// which the user pastes in the intake screen. So this route only reports
// whether TTS is configured (drives the "(TTS not configured)" hint). It no
// longer attempts to list voices.
export async function GET() {
  return NextResponse.json({ voices: [], configured: isSixtyNineConfigured() });
}
