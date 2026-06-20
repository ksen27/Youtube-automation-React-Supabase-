/* eslint-disable no-console */
// Lightweight test runner for the synthetic engine's pure-logic units.
// Matches the project's tsx-script convention (no jest/vitest dependency).
//
//   npx tsx --env-file=.env.local scripts/test-synthetic.ts
//
// Covers the deterministic, side-effect-free pieces: AES-256-GCM secret box,
// cost estimation, proxy parsing/resolution, and the style-prompt helper.
// DB- and network-bound code (processors, providers) is integration-tested
// against live services, not here.

import assert from "node:assert";

// SECRET_BOX_KEY must be present for the crypto tests. Set a deterministic
// 32-byte hex key if the env didn't provide one (test-only).
process.env.SECRET_BOX_KEY ||= "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}

async function main() {
  console.log("secret-box");
  {
    const { encryptSecret, decryptSecret, encryptJson, decryptJson } = await import("@/lib/crypto/secret-box");
    test("round-trips a string", () => {
      const pt = "hunter2 — sünthetic 🔐";
      assert.strictEqual(decryptSecret(encryptSecret(pt)), pt);
    });
    test("ciphertext differs each call (random IV)", () => {
      assert.notStrictEqual(encryptSecret("x"), encryptSecret("x"));
    });
    test("tamper detection throws", () => {
      const ct = encryptSecret("secret");
      const bytes = Buffer.from(ct, "base64");
      bytes[bytes.length - 1] ^= 0xff; // flip a ciphertext bit
      assert.throws(() => decryptSecret(bytes.toString("base64")));
    });
    test("json round-trips, null stays null", () => {
      const v = { cookies: [{ name: "a", value: "b" }], origins: [] };
      assert.deepStrictEqual(decryptJson(encryptJson(v)), v);
      assert.strictEqual(decryptJson(null), null);
    });
  }

  console.log("cost");
  {
    const { estimateCost } = await import("@/lib/synthetic/cost");
    test("tts bills per 1k chars", () => {
      assert.ok(Math.abs(estimateCost({ provider: "sixtynine_tts", chars: 2000 }) - 0.03) < 1e-9);
    });
    test("image bills per image", () => {
      assert.ok(Math.abs(estimateCost({ provider: "sixtynine_image", images: 3 }) - 0.12) < 1e-9);
    });
    test("video bills per second", () => {
      assert.ok(Math.abs(estimateCost({ provider: "fal_veo3_fast", seconds: 5 }) - 0.5) < 1e-9);
    });
    test("missing dimension -> 0", () => {
      assert.strictEqual(estimateCost({ provider: "fal_kling" }), 0);
    });
  }

  console.log("heygen proxy");
  {
    const { parseProxy } = await import("@/lib/synthetic/heygen-accounts");
    test("parses ip:port:user:pass", () => {
      assert.deepStrictEqual(parseProxy("1.2.3.4:8080:joe:p@ss:word"), {
        server: "http://1.2.3.4:8080",
        username: "joe",
        password: "p@ss:word",
      });
    });
    test("parses ip:port only", () => {
      assert.deepStrictEqual(parseProxy("1.2.3.4:8080"), { server: "http://1.2.3.4:8080" });
    });
  }

  console.log("style prompt");
  {
    const { withStylePrompt, STYLE_PROMPT } = await import("@/lib/synthetic/constants");
    test("appends the style prompt", () => {
      const out = withStylePrompt("a cat on a sofa.");
      assert.ok(out.startsWith("a cat on a sofa."));
      assert.ok(out.includes(STYLE_PROMPT));
    });
  }

  console.log("doc marks");
  {
    const { extractAvatarDoc, segmentIsAvatarMarked } = await import("@/lib/synthetic/doc-marks");
    const red = { color: { rgbColor: { red: 0.8, green: 0, blue: 0 } } };
    const orange = { color: { rgbColor: { red: 1.0, green: 0.6, blue: 0.0 } } };
    const doc = {
      documentId: "d", title: "T",
      body: { content: [
        { paragraph: { elements: [
          { textRun: { content: "Plain intro. " } },
          { textRun: { content: "I felt scared.", textStyle: { foregroundColor: red } } },
          { textRun: { content: " Then it ended." } },
        ] } },
        { paragraph: { elements: [
          { textRun: { content: "An orange beat.", textStyle: { foregroundColor: orange } } },
        ] } },
      ] },
    };
    const out = extractAvatarDoc(doc);
    test("transcript concatenates all runs", () => {
      assert.ok(out.transcript.includes("Plain intro."));
      assert.ok(out.transcript.includes("I felt scared."));
      assert.ok(out.transcript.includes("An orange beat."));
    });
    test("red + orange runs both become avatar ranges", () => {
      assert.strictEqual(out.avatarRanges.length, 2);
    });
    test("avatar range covers the red span", () => {
      const idx = out.transcript.indexOf("I felt scared.");
      assert.ok(segmentIsAvatarMarked(idx, idx + 5, out.avatarRanges));
    });
    test("plain text is not marked", () => {
      const idx = out.transcript.indexOf("Plain intro.");
      assert.ok(!segmentIsAvatarMarked(idx, idx + 5, out.avatarRanges));
    });

    // Regression: leading whitespace must not shift the avatar ranges. Before
    // the fix, trim() shifted the transcript but not the ranges, so marks
    // landed on the wrong sentences.
    test("ranges stay aligned after leading-whitespace trim", () => {
      const red2 = { color: { rgbColor: { red: 0.8, green: 0, blue: 0 } } };
      const doc2 = {
        documentId: "d2", title: "T2",
        body: { content: [{ paragraph: { elements: [
          { textRun: { content: "   \n  " } },                                   // leading whitespace
          { textRun: { content: "AVATARLINE.", textStyle: { foregroundColor: red2 } } },
          { textRun: { content: " plain tail." } },
        ] } }] },
      };
      const o2 = extractAvatarDoc(doc2);
      const aIdx = o2.transcript.indexOf("AVATARLINE");
      const tIdx = o2.transcript.indexOf("plain tail");
      assert.ok(aIdx >= 0 && tIdx >= 0);
      // The marked range must cover AVATARLINE and NOT the plain tail.
      assert.ok(segmentIsAvatarMarked(aIdx, aIdx + 5, o2.avatarRanges));
      assert.ok(!segmentIsAvatarMarked(tIdx, tIdx + 5, o2.avatarRanges));
    });
  }

  console.log("ltx duration snap");
  {
    const { snapDuration, LTX_DURATION_TIERS } = await import("@/lib/synthetic/ltx");
    test("snaps 7s to the nearest tier (6)", () => {
      // 7 is equidistant from 6 and 8; the loop keeps the first (6) on a tie.
      assert.strictEqual(snapDuration(7, 20), 6);
    });
    test("snaps 8s exactly to 8", () => {
      assert.strictEqual(snapDuration(8, 20), 8);
    });
    test("rounds a sub-tier request up to the 6s floor", () => {
      assert.strictEqual(snapDuration(3, 20), 6);
      assert.strictEqual(snapDuration(0.5, 20), 6);
    });
    test("never returns a tier above maxDuration", () => {
      // With max=10 the only allowed tiers are 6/8/10; a 21s ask clamps to 10.
      assert.strictEqual(snapDuration(21, 10), 10);
    });
    test("every tier is a valid LTX value", () => {
      for (const t of LTX_DURATION_TIERS) {
        assert.strictEqual(snapDuration(t, 20), t);
      }
    });
  }

  console.log("synthetic duration split");
  {
    const { splitByDuration } = await import("@/lib/synthetic/planner");
    // Minimal PlannedSegment factory — only the fields splitByDuration reads.
    const mk = (over: Partial<Record<string, unknown>> = {}) => ({
      position: 0,
      blockType: "ai_clip" as const,
      startTime: 0,
      endTime: 21,
      duration: 21,
      script: "one two three four five six seven eight nine ten eleven twelve",
      imagePrompt: "a busy market street",
      animationPrompt: "slow push-in",
      ...over,
    });

    test("a 21s ai_clip splits into 4 sub-blocks of ~5.25s", () => {
      // slots = round(21 / 6) = round(3.5) = 4; 21 / 4 = 5.25s each, all in 3-8s.
      const out = splitByDuration(mk(), 6, 8);
      assert.strictEqual(out.length, 4);
      for (const p of out) assert.ok(Math.abs(p.duration - 5.25) < 1e-9);
    });
    test("each sub-block stays under the 8s threshold", () => {
      const out = splitByDuration(mk(), 6, 8);
      for (const p of out) assert.ok(p.duration <= 8, `slot ${p.duration}s > 8s`);
    });
    test("sub-blocks tile the parent window with no gap/overlap", () => {
      const out = splitByDuration(mk(), 6, 8);
      assert.ok(Math.abs(out[0].startTime - 0) < 1e-9);
      assert.ok(Math.abs(out[out.length - 1].endTime - 21) < 1e-9);
      for (let i = 1; i < out.length; i++) {
        assert.ok(Math.abs(out[i].startTime - out[i - 1].endTime) < 1e-9, "gap between slots");
      }
    });
    test("sub-blocks inherit the parent's prompts and type", () => {
      const out = splitByDuration(mk(), 6, 8);
      for (const p of out) {
        assert.strictEqual(p.blockType, "ai_clip");
        assert.strictEqual(p.imagePrompt, "a busy market street");
        assert.strictEqual(p.animationPrompt, "slow push-in");
      }
    });
    test("a block at/under threshold is returned unchanged", () => {
      const seg = mk({ endTime: 7, duration: 7 });
      const out = splitByDuration(seg, 6, 8);
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0], seg);
    });
    test("avatar blocks are NEVER split", () => {
      const seg = mk({ blockType: "avatar", endTime: 30, duration: 30 });
      const out = splitByDuration(seg, 6, 8);
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].blockType, "avatar");
    });
    test("concatenated sub-block scripts cover the parent script words", () => {
      const out = splitByDuration(mk(), 6, 8);
      const joined = out.map((p) => p.script).join(" ").replace(/\s+/g, " ").trim();
      // Every parent word should appear across the slices (boundary-snapped,
      // so no word is cut in half).
      for (const w of "one two three four five six seven eight nine ten eleven twelve".split(" ")) {
        assert.ok(joined.includes(w), `missing word "${w}" after split`);
      }
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
