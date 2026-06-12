import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthConfigured, verifyPassword } from "@/lib/auth";
import { getStoredPasswordHash, hasCustomPassword, setPassword } from "@/lib/auth-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Change the shared access password. This route is NOT in proxy.ts's public
// list, so the caller is already authenticated (has a valid session cookie).
// As a second factor we also require the CURRENT password — so a borrowed
// already-logged-in browser can't silently lock everyone else out.

const Body = z.object({
  currentPassword: z.string().min(1),
  // Minimum length is the one real policy — keep it modest but non-trivial.
  newPassword: z.string().min(8, "New password must be at least 8 characters."),
});

// GET → does a custom (DB-stored) password exist yet? Used by the settings UI
// to tell the user whether they're still on the bootstrap env password.
export async function GET() {
  try {
    return NextResponse.json({ hasCustomPassword: await hasCustomPassword() });
  } catch {
    return NextResponse.json({ hasCustomPassword: false });
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthConfigured()) {
    return NextResponse.json({ error: "Auth is not configured on the server." }, { status: 503 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message ?? "Invalid request.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  const { currentPassword, newPassword } = parsed.data;

  const ok = await verifyPassword(currentPassword, getStoredPasswordHash);
  if (!ok) {
    return NextResponse.json({ error: "Current password is incorrect." }, { status: 403 });
  }

  if (newPassword === currentPassword) {
    return NextResponse.json(
      { error: "New password must be different from the current one." },
      { status: 400 },
    );
  }

  try {
    await setPassword(newPassword);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || "Could not save the new password." },
      { status: 500 },
    );
  }

  // Note: existing sessions stay valid (the session cookie is signed with
  // AUTH_SECRET, independent of the password). Only NEW logins need the new
  // password. That's the desired behavior for a shared internal tool.
  return NextResponse.json({ ok: true });
}
