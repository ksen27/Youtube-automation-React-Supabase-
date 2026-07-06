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

    test("a long ai_clip splits into ~target-second even slots", () => {
      // 21s at target 6 -> round(21/6) = 4 slots of 5.25s. A midpoint-only
      // split used to leave two 10.5s halves, still over the 8s threshold.
      const out = splitByDuration(mk(), 6, 8);
      assert.strictEqual(out.length, 4);
      for (const p of out) assert.ok(Math.abs(p.duration - 5.25) < 1e-9);
    });
    test("a very long sentence never leaves a slot over the threshold", () => {
      // The screenshot bug: a 26s sentence became two 13s blocks.
      const out = splitByDuration(mk({ endTime: 26, duration: 26 }), 6, 8);
      assert.strictEqual(out.length, 4);
      for (const p of out) assert.ok(p.duration <= 8, `slot ${p.duration}s over threshold`);
    });
    test("slot 1 is the ai_clip, later slots are fill images", () => {
      const out = splitByDuration(mk(), 6, 8);
      assert.strictEqual(out[0].blockType, "ai_clip");
      for (const p of out.slice(1)) {
        // Fill images drop the animation prompt and are flagged as second
        // visuals (slot 2 would carry imagePrompt2 instead, when present).
        assert.strictEqual(p.blockType, "image");
        assert.strictEqual(p.animationPrompt, null);
        assert.strictEqual(p.secondVisual, true);
      }
    });
    test("slot 2 uses imagePrompt2 when present; slots 3+ stay secondVisual", () => {
      const out = splitByDuration(mk({ imagePrompt2: "a quiet harbor at dawn" }), 6, 8);
      assert.strictEqual(out[1].imagePrompt, "a quiet harbor at dawn");
      assert.strictEqual(out[1].secondVisual, false);
      for (const p of out.slice(2)) {
        assert.strictEqual(p.imagePrompt, "a busy market street");
        assert.strictEqual(p.secondVisual, true);
      }
    });
    test("sub-blocks tile the parent window with no gap/overlap", () => {
      const out = splitByDuration(mk(), 6, 8);
      assert.ok(Math.abs(out[0].startTime - 0) < 1e-9);
      assert.ok(Math.abs(out[out.length - 1].endTime - 21) < 1e-9);
      for (let i = 1; i < out.length; i++) {
        assert.ok(Math.abs(out[i].startTime - out[i - 1].endTime) < 1e-9, "gap between slots");
      }
    });
    test("both pieces inherit the parent's image prompt; clip keeps animation", () => {
      const out = splitByDuration(mk(), 6, 8);
      // Both pieces describe the SAME full-sentence scene.
      for (const p of out) assert.strictEqual(p.imagePrompt, "a busy market street");
      // Only the clip piece carries motion.
      assert.strictEqual(out[0].animationPrompt, "slow push-in");
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

  console.log("split_2 duration cap");
  {
    const { capSplit2Duration, firstSentenceEnd } = await import("@/lib/synthetic/planner");
    const script =
      "Here is what the executives demanded. The engine must produce more power. " +
      "It must tow more weight. It must fit a smaller bay. And it must be cheaper.";
    const mk = (over: Partial<Record<string, unknown>> = {}) => ({
      position: 0,
      blockType: "split_2" as const,
      startTime: 10,
      endTime: 48,
      duration: 38,
      script,
      imagePrompt: "a modern ute towing a large caravan",
      animationPrompt: null,
      ...over,
    });

    test("firstSentenceEnd finds the first internal boundary", () => {
      assert.strictEqual(firstSentenceEnd("Hello there. And more."), "Hello there.".length);
      // A single sentence (terminator only at the very end) has no INTERNAL boundary.
      assert.strictEqual(firstSentenceEnd("Just one sentence."), -1);
      assert.strictEqual(firstSentenceEnd("no terminator at all"), -1);
    });
    test("an over-long split_2 carves into first-sentence split_2 + image remainder", () => {
      // The screenshot bug: a 38s five-sentence split_2 held one still for 38s.
      const { segments, carved, demoted, regen } = capSplit2Duration([mk()], 12);
      assert.strictEqual(carved, 1);
      assert.strictEqual(demoted, 0);
      assert.strictEqual(segments.length, 2);
      assert.strictEqual(segments[0].blockType, "split_2");
      assert.strictEqual(segments[0].script, "Here is what the executives demanded.");
      assert.ok(segments[0].duration <= 12, `head still ${segments[0].duration}s over cap`);
      assert.strictEqual(segments[1].blockType, "image");
      assert.ok(segments[1].script.startsWith("The engine must"));
      // Both pieces need a prompt regen (the inherited prompt described the whole passage).
      assert.strictEqual(regen.length, 2);
      // The pieces tile the parent window.
      assert.ok(Math.abs(segments[0].startTime - 10) < 1e-9);
      assert.ok(Math.abs(segments[0].endTime - segments[1].startTime) < 1e-9);
      assert.ok(Math.abs(segments[1].endTime - 48) < 1e-9);
    });
    test("a single-sentence over-long split_2 is demoted whole to image", () => {
      const seg = mk({ script: "One very long sentence with no internal boundary at all." });
      const { segments, carved, demoted, regen } = capSplit2Duration([seg], 12);
      assert.strictEqual(carved, 0);
      assert.strictEqual(demoted, 1);
      assert.strictEqual(segments.length, 1);
      assert.strictEqual(segments[0].blockType, "image");
      assert.strictEqual(regen.length, 0);
    });
    test("a split_2 at/under the cap is untouched", () => {
      const seg = mk({ endTime: 21, duration: 11 });
      const { segments, carved, demoted } = capSplit2Duration([seg], 12);
      assert.strictEqual(carved + demoted, 0);
      assert.strictEqual(segments[0], seg);
    });
    test("non-split_2 blocks are never touched; cap 0 disables the pass", () => {
      const img = mk({ blockType: "image" });
      const r1 = capSplit2Duration([img], 12);
      assert.strictEqual(r1.segments[0], img);
      const r2 = capSplit2Duration([mk()], 0);
      assert.strictEqual(r2.segments[0].blockType, "split_2");
      assert.strictEqual(r2.segments.length, 1);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
