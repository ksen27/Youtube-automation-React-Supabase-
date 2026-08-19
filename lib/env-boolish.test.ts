import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// BOOLEAN ENV FLAGS (2026-08-19).
//
// Every flag in lib/env.ts used to be `z.coerce.boolean()`, i.e. `Boolean(value)`
// — and `Boolean("false")` is `true`. Flags set to "false" in fly.avatar.toml or
// a Fly secret ran as ON, and the only way to disable one was to unset it.
//
// That shipped: SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF = "false" ran as TRUE and
// confined the whole clip budget to the first 15 minutes, so a 31-minute video
// rendered its back half with no moving footage while the summary log reported a
// correct 30.3% clip share.
//
// These tests exist so that regression cannot return silently.

const KEYS = [
  "SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF",
  "SYNTHETIC_VEO_ENABLED",
  "ASSET_LIBRARY_ENABLED",
  "SYNTHETIC_SCENE_DEDUPE_ENABLED",
  "SYNTHETIC_AUTO_DISPATCH",
  "SYNTHETIC_PLAN_ALIGN_FIRST",
  "HEYGEN_HEADLESS",
];

const saved: Record<string, string | undefined> = {};

/** Load a FRESH copy of the env module — getEnv() caches its parse per process. */
async function loadEnv() {
  vi.resetModules();
  const mod = await import("@/lib/env");
  return (mod as { getEnv: () => Record<string, unknown> }).getEnv();
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("boolean env flags", () => {
  it('treats "false" as OFF, not ON', async () => {
    // The exact bug: this string used to parse as true.
    process.env.SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF = "false";
    const env = await loadEnv();
    expect(env.SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF).toBe(false);
  });

  it("accepts the usual off-spellings, any case or padding", async () => {
    for (const off of ["false", "FALSE", "False", " false ", "0", "no", "off", "OFF"]) {
      process.env.SYNTHETIC_VEO_ENABLED = off;
      const env = await loadEnv();
      expect(env.SYNTHETIC_VEO_ENABLED, `"${off}" should be OFF`).toBe(false);
    }
  });

  it("keeps on-spellings on", async () => {
    for (const on of ["true", "TRUE", "1", "yes", "on"]) {
      process.env.SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF = on;
      const env = await loadEnv();
      expect(env.SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF, `"${on}" should be ON`).toBe(true);
    }
  });

  it("falls back to the default when unset", async () => {
    delete process.env.SYNTHETIC_VEO_ENABLED;
    delete process.env.SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF;
    const env = await loadEnv();
    expect(env.SYNTHETIC_VEO_ENABLED).toBe(true);            // default true
    expect(env.SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF).toBe(false); // default false
  });

  it("treats an EMPTY value as not-configured, flipping nothing", async () => {
    // A blank var is an accident, not an instruction. It must not turn a
    // default-on flag off (the old coercion did) or a default-off flag on.
    process.env.SYNTHETIC_VEO_ENABLED = "";
    process.env.SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF = "";
    const env = await loadEnv();
    expect(env.SYNTHETIC_VEO_ENABLED).toBe(true);
    expect(env.SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF).toBe(false);
  });

  it("is applied to every boolean flag, not just the one that broke", async () => {
    // The fix is only worth having if it is systemic — the next flag someone
    // sets to "false" must also work.
    process.env.ASSET_LIBRARY_ENABLED = "false";
    process.env.SYNTHETIC_SCENE_DEDUPE_ENABLED = "false";
    process.env.SYNTHETIC_AUTO_DISPATCH = "false";
    process.env.SYNTHETIC_PLAN_ALIGN_FIRST = "false";
    process.env.HEYGEN_HEADLESS = "false";
    const env = await loadEnv();
    expect(env.ASSET_LIBRARY_ENABLED).toBe(false);
    expect(env.SYNTHETIC_SCENE_DEDUPE_ENABLED).toBe(false);
    expect(env.SYNTHETIC_AUTO_DISPATCH).toBe(false);
    expect(env.SYNTHETIC_PLAN_ALIGN_FIRST).toBe(false);
    expect(env.HEYGEN_HEADLESS).toBe(false);
  });
});
