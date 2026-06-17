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
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
