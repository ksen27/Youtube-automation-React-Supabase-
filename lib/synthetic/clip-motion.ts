// WHAT AN ai_clip SHOULD ANIMATE, given what is actually in the still.
//
// THE BUG THIS EXISTS FOR (client 2026-08-22: "why the all clip is ther hands?")
// -----------------------------------------------------------------------------
// DEFAULT_ACTION_ANIMATION_PROMPT opens with "The person in the frame continues
// the everyday action they are already doing". That is correct only when there
// IS a person in the frame. Measured on a live 77-clip project: just 13% of
// ai_clip image prompts mentioned a person or hands at all -- the rest were
// close-ups of spider webs, bark, exoskeletons. Every one of those was still
// told to animate a person.
//
// A diffusion model cannot decline. With no person to move, it grows hands out
// of the scene, which produces both symptoms the client reported:
//   - "why is every clip hands" -- because the prompt demanded a human action
//   - "around the hands the quality is not good" -- because the hands have no
//     anatomical anchor in the source frame, so the model DEFORMS surrounding
//     pixels into them. The damage is worst next to the invented limb, and the
//     anatomy drifts (extra fingers, mismatched left/right) because there was
//     never a reference to stay consistent with.
//
// The blocks reach the clip lane by TIMING, not by content: the clip quota
// promotes whatever lands in the right window to hit the animation schedule
// (`promotedToClip: 34` on that project). The planner's own rule -- "if a
// block's narration genuinely has no human action in it, that block should be
// an `image`" -- cannot survive a quota that overrides it. One segment's stored
// prompt was literally "no human action", and it was animated anyway.
//
// So: keep the promotion, change what those blocks are asked to DO. A spider web
// should shimmer and sway, not sprout fingers.

import { ACTION_CLIP_RULE, DEFAULT_ACTION_ANIMATION_PROMPT } from "@/lib/synthetic/constants";

// Words that mean a HUMAN is depicted. Deliberately conservative and literal --
// the cost of a false positive (animating a person who is not there) is the bug
// above, while a false negative just gives a person-containing scene ambient
// motion, which still looks like real footage.
//
// Body parts count: "a hand reaching into a drawer" has no "person" in it but
// unmistakably shows one.
const PERSON_PATTERN =
  /\b(person|people|human|man|men|woman|women|boy|girl|child|children|kid|adult|figure|someone|somebody|hand|hands|finger|fingers|palm|arm|arms|face|head|shoulder|leg|legs|foot|feet|researcher|scientist|villager|worker|farmer|hunter|explorer|guide|crew|team|family|couple|he|she|his|her|him|they|their)\b/i;

/**
 * Does this scene description depict a human?
 *
 * Runs on the IMAGE prompt (what the still actually shows), not the narration:
 * the narration can discuss people while the picture is a close-up of a web.
 */
export function sceneHasPerson(imagePrompt: string | null | undefined): boolean {
  const p = (imagePrompt ?? "").trim();
  if (!p) return false;
  return PERSON_PATTERN.test(p);
}

// For stills with NO person. Asks for the motion a locked-off camera would
// genuinely catch in that scene, so the clip reads as real footage rather than
// a still with something bolted on.
//
// The camera/low-fi half is shared with ACTION_CLIP_RULE so a person-less clip
// still matches the surrounding footage's texture -- only the SUBJECT of the
// motion differs. The explicit "no people appear" is the whole point: it is the
// instruction that stops hands being invented.
export const AMBIENT_MOTION_ANIMATION_PROMPT =
  "Bring the scene to life with its own NATURAL AMBIENT MOTION — only what is " +
  "already in the frame moves, slowly and gently: leaves and foliage stirring " +
  "in a light breeze, water rippling or dripping, dust or insects drifting " +
  "through the air, light shifting softly across surfaces, a web or thread " +
  "swaying. " +
  "NO PEOPLE APPEAR and no hands, fingers, arms or any part of a body enters " +
  "the frame at any point — nothing is added to the scene that is not already " +
  "visible in it. " +
  "The movement is UNHURRIED but CLEARLY VISIBLE — steady and continuous from " +
  "the first frame to the last, never rushed or jerky, and never so slight that " +
  "the shot could be mistaken for a still photograph. " +
  "The CAMERA IS COMPLETELY STILL AND LOCKED OFF on a tripod — absolutely NO " +
  "camera movement of any kind: no push-in, no zoom, no pan, no tilt, no " +
  "tracking, no orbit, no camera shake; the framing never changes. " +
  "Handheld phone video look, slightly low quality and grainy like a real home " +
  "vlog clip — not smooth, not cinematic, no colour grading, no on-screen text.";

/**
 * Pick the animation prompt for a clip.
 *
 * A STORED per-block prompt always wins: it is editable on the review screen,
 * and silently overriding what an operator can see would make that screen lie
 * about what will render. This only decides the FALLBACK, which measured 60 of
 * 77 clips on a live project.
 */
export function resolveAnimationPrompt(
  storedAnimationPrompt: string | null | undefined,
  imagePrompt: string | null | undefined,
): { prompt: string; source: "stored" | "action_default" | "ambient_default" } {
  const stored = (storedAnimationPrompt ?? "").trim();
  if (stored) return { prompt: stored, source: "stored" };
  return sceneHasPerson(imagePrompt)
    ? { prompt: DEFAULT_ACTION_ANIMATION_PROMPT, source: "action_default" }
    : { prompt: AMBIENT_MOTION_ANIMATION_PROMPT, source: "ambient_default" };
}

// Re-exported so callers that only need the rule text do not have to import from
// two modules.
export { ACTION_CLIP_RULE };
