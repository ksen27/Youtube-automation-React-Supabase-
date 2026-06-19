import { NextResponse } from "next/server";
import { z } from "zod";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { isSecretBoxConfigured } from "@/lib/crypto/secret-box";
import {
  listAccountsSafe,
  addAccount,
  removeAccount,
  setAccountStatus,
} from "@/lib/synthetic/heygen-accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HeyGen account-pool management for the settings page.
//   GET    – list accounts (status fields only — NEVER secrets).
//   POST   – add an account (email + password, optional proxy). Encrypted.
//   PATCH  – set status (active/cooldown/disabled) — manual enable/disable.
//   DELETE – remove an account by id.

function guard(): NextResponse | null {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }
  if (!isSecretBoxConfigured()) {
    return NextResponse.json(
      { error: "SECRET_BOX_KEY not configured — cannot store HeyGen credentials" },
      { status: 503 },
    );
  }
  return null;
}

export async function GET() {
  const g = guard();
  if (g) return g;
  const accounts = await listAccountsSafe();
  return NextResponse.json({ accounts });
}

const AddSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(500),
  proxy: z.string().max(300).optional(),
});

export async function POST(req: Request) {
  const g = guard();
  if (g) return g;
  const body = AddSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: "invalid input", issues: body.error.flatten() }, { status: 400 });
  }
  try {
    const id = await addAccount(body.data);
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    // Unique-violation on email -> 409.
    const msg = (e as Error).message;
    const status = /duplicate|unique/i.test(msg) ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

const PatchSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["active", "cooldown", "disabled", "needs_reauth"]),
});

export async function PATCH(req: Request) {
  const g = guard();
  if (g) return g;
  const body = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: "invalid input", issues: body.error.flatten() }, { status: 400 });
  }
  await setAccountStatus(body.data.id, body.data.status);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const g = guard();
  if (g) return g;
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "valid id query param required" }, { status: 400 });
  }
  await removeAccount(id);
  return NextResponse.json({ ok: true });
}
