// Server-only DB access for the access-password hash. Kept separate from
// lib/auth.ts so that module (whose cookie helpers are imported by the
// lightweight proxy) never statically pulls in the Supabase client.

import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";
import { PASSWORD_SETTING_KEY, hashPassword } from "@/lib/auth";

// Read the stored password hash, or null if none has been set / DB unavailable.
export async function getStoredPasswordHash(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("app_settings")
    .select("value")
    .eq("key", PASSWORD_SETTING_KEY)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value ?? null;
}

// True once the client has set their own password in-app (vs. still on the env
// bootstrap). Lets the settings UI show whether a custom password is active.
export async function hasCustomPassword(): Promise<boolean> {
  return (await getStoredPasswordHash()) !== null;
}

// Hash and persist a new access password. Upserts the single settings row.
export async function setPassword(newPassword: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase not configured — cannot store the password.");
  }
  const value = await hashPassword(newPassword);
  const sb = getServerSupabase();
  const { error } = await sb
    .from("app_settings")
    .upsert({ key: PASSWORD_SETTING_KEY, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}
