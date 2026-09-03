import { z } from "zod";
import { getEnv } from "@/lib/env";
import { withGeminiModelFallback, makeLimit } from "@/lib/ai/gemini";
import { getServerSupabase } from "@/lib/supabase/server";
import { logJob } from "@/lib/jobs/db";
import type { WordTiming } from "@/lib/ai/deepgram";
import { alignSentencesToWords } from "@/lib/ai/sentence-alignment";
import type { Sentence } from "@/lib/ai/sentences";
import {
  buildTimedSentences,
  repairCoverage,
  type TimedSentence,
} from "@/lib/synthetic/sentence-windows";
import { NAMED_IP_RULE, SAFE_DEPICTION_RULE } from "@/lib/synthetic/safe-depiction";
import { selectCharacterBlocks } from "@/lib/synthetic/character-blocks";
import { verifyAndRepair } from "@/lib/synthetic/match-verify";
import type { SyntheticBlockType } from "@/lib/types";
import { type AvatarMarkRange, type AvatarModel } from "@/lib/synthetic/doc-marks";
import {
  DEFAULT_LANGUAGE,
  getLocale,
  onImageTextRule,
  promptLanguageRule,
  visualCultureRule,
  type LanguageCode,
} from "@/lib/i18n/locale";

// Synthetic timeline planner. Gemini reads the transcript and segments it into
// ordered visual blocks, choosing a block_type per the spec rules:
//   * Emotional / first-person statements      -> avatar
//   * Explanations / factual exposition         -> image
//   * Action / dynamic scenes                   -> ai_clip
//   * Mixed explanation (talk + illustrate)     -> split_2
//
// Each segment carries the narration it covers plus an imagePrompt (for
// image/ai_clip/split_2) and an animationPrompt (for ai_clip). The mandatory
// STYLE_PROMPT is appended later at image-generation time, NOT here, so the
// stored prompt stays editable on the review screen without the boilerplate.
//
// After Gemini returns segment text, we align each segment to the master
// voiceover using Deepgram word timings so start/end/duration reflect real
// spoken time (same principle as the sourced engine's sentence alignment).

const PLANNER_BLOCK_TYPES: SyntheticBlockType[] = ["avatar", "image", "ai_clip", "split_2"];

// Optional STRING field that tolerates an explicit JSON `null`. Gemini emits
// `"imagePrompt": null` (etc.) for blocks that legitimately have no value (an
// avatar block has no image prompt) and the salvage path for a MAX_TOKENS-
// truncated response also yields nulls. z.string().optional().default("") does
// NOT coerce an explicit null — it only fills a MISSING key — so a single null
// threw "Expected string, received null" and failed the ENTIRE plan (observed
// on a re-plan: 100+ salvaged segments rejected wholesale). nullish + a
// null->"" transform makes these fields accept null and normalize it to "".
const optString = () =>
  z
    .string()
    .nullish()
    .transform((v) => v ?? "");

const GeminiSegmentSchema = z.object({
  blockType: z.enum(["avatar", "image", "ai_clip", "split_2"]),
  // The contiguous slice of transcript this block covers. Used to find the
  // block's spoken window in the word timings.
  script: z.string().min(1),
  imagePrompt: optString(),
  // The shot type / framing for this block's still, rotated across the video so
  // consecutive images don't all read as the same "hands-in-the-dirt close-up".
  // Drives real visual VARIETY (scale + angle) on top of the subject change. See
  // SHOT_TYPES / the shot-variety rule. Empty -> generation adds no shot hint.
  shotType: optString(),
  // A SECOND, genuinely DIFFERENT scene for the same sentence. A long sentence
  // (> SYNTHETIC_BLOCK_SPLIT_THRESHOLD) is covered by TWO visuals; without a
  // distinct prompt the second one reused imagePrompt + a weak "different angle"
  // suffix and nano-banana drew a near-clone. imagePrompt2 lets Gemini describe
  // a different subject / moment / detail OF THE SAME sentence so the two
  // visuals don't look like duplicates. Only used when the block actually splits
  // (short blocks ignore it); empty for avatar blocks.
  imagePrompt2: optString(),
  // Shot type for the SECOND visual — different from shotType so the two frames
  // of a split sentence differ in framing as well as subject.
  shotType2: optString(),
  // EXTRA SCENES for a long sentence, one per remaining time slot (client
  // "Joey" 2026-09-03). imagePrompt/imagePrompt2 cover at most TWO slots; a
  // 14s sentence splits into four, and slots 3+ used to re-render slot 1's
  // prompt with a "different angle" nudge — which is literally the same shot
  // again, and is what he was pointing at ("the same footage over and over
  // again ... it doesn't match the script very well").
  //
  // The reference video he sent cuts on PHRASES, not sentences: "grocery
  // store" -> a grocery store, "the bacon, the chicken" -> bacon, chicken,
  // "my barn" -> a barn, "saves money" -> a wallet. One sentence carries
  // several DIFFERENT shots, each bound to its own clause. That is only
  // possible if the planner emits a prompt per SLOT rather than per sentence.
  //
  // Each entry is {imagePrompt, shotType} for one further slot, in order, and
  // must describe a DIFFERENT concrete thing named in the sentence — not
  // another angle on the same one. Empty/absent falls back to the old
  // secondVisual behaviour, so an older model response still plans.
  extraScenes: z
    .array(z.object({ imagePrompt: optString(), shotType: optString() }))
    .nullish()
    .transform((v) => v ?? []),
  animationPrompt: optString(),
});
// Align-first block. Identical creative fields to GeminiSegmentSchema, except
// the narration is referenced by SENTENCE INDEX instead of being echoed back as
// text. That single change is what removes the text search — and with it the
// desync that let a plan finish ~725s behind its own audio.
//
// z.coerce.number() because Gemini intermittently quotes integers ("12").
const SentenceBlockSchema = z.object({
  startSentence: z.coerce.number().int().nonnegative(),
  endSentence: z.coerce.number().int().nonnegative(),
  blockType: z.enum(["avatar", "image", "ai_clip", "split_2"]),
  imagePrompt: optString(),
  shotType: optString(),
  imagePrompt2: optString(),
  shotType2: optString(),
  // Per-slot scenes for a long sentence; see the note on GeminiSegmentSchema.
  extraScenes: z
    .array(z.object({ imagePrompt: optString(), shotType: optString() }))
    .nullish()
    .transform((v) => v ?? []),
  animationPrompt: optString(),
});
// NOTE the array key is `segments`, matching the legacy schema, so
// salvageTruncatedTimeline (which recovers complete objects from a response
// truncated at MAX_TOKENS) works for this path unchanged.
const SentenceResponseSchema = z.object({
  basePrompt: optString(),
  segments: z.array(SentenceBlockSchema),
});

const GeminiResponseSchema = z.object({
  // A global "style bible" for the whole video: the recurring subjects, setting,
  // era, and mood that every block shares. Composed in FRONT of each block's
  // scene-specific imagePrompt at persist time so adjacent blocks describing the
  // same scene generate as one continuous world instead of drifting apart.
  basePrompt: optString(),
  segments: z.array(GeminiSegmentSchema),
});

export interface PlannedSegment {
  position: number;
  blockType: SyntheticBlockType;
  startTime: number;
  endTime: number;
  duration: number;
  script: string;
  imagePrompt: string | null;
  // Shot type / framing hint for this block's still (e.g. "macro close-up",
  // "wide establishing shot", "product shot"). Rotated across blocks for visual
  // variety; folded into the composed image_prompt at persist time.
  shotType?: string | null;
  // A distinct second scene for the SAME sentence, used as the second visual's
  // prompt when a long sentence is split (see splitByDuration). Null/undefined
  // when Gemini didn't supply one — then the second visual falls back to varying
  // imagePrompt via the secondVisual nudge.
  imagePrompt2?: string | null;
  // Shot type for the SECOND visual (paired with imagePrompt2).
  shotType2?: string | null;
  // Further per-slot scenes for a long sentence, in slot order, each a
  // DIFFERENT concrete thing the sentence names. Consumed by splitByDuration
  // for slots 3+ (slot 1 uses imagePrompt, slot 2 imagePrompt2). Empty means
  // fall back to the secondVisual "different angle" nudge — which is what made
  // long sentences render the same shot repeatedly. See GeminiSegmentSchema.
  extraScenes?: Array<{ imagePrompt: string; shotType: string }>;
  animationPrompt: string | null;
  // WHICH CLIP ENGINE renders this block, set by assignClipDurationQuota.
  // Meaningful only on ai_clip blocks; null everywhere else. "ltx" is the
  // workhorse (~25% of a video) and "veo" the 69labs Veo 3.1 Lite lane (~5%).
  // Persisted into synthetic_segments.metadata.clip_engine so the processor can
  // route without re-deriving the plan.
  clipEngine?: "ltx" | "veo" | null;
  // Exact char range in the transcript this block covers. Set by the
  // align-first path from the sentence offsets it groups. Undefined on the
  // legacy path, which has no reliable offsets (Gemini's script text is a
  // paraphrase) and must fall back to a normalized text search — see the
  // avatar-marking pass, the second fuzzy matcher this replaces.
  charStart?: number;
  charEnd?: number;
  // Which HeyGen model an avatar-bearing block renders with. Set by avatar
  // marking from the doc-highlight color (red -> avatar_iv, orange ->
  // avatar_iii). Null on every non-avatar block; null on an avatar block means
  // the worker default (Avatar IV). See applyMark / coalesceAvatarSegments.
  avatarModel?: AvatarModel | null;
  // True for the SECOND visual attached to a long sentence (see
  // splitByDuration). The second visual prefers imagePrompt2; if that's absent
  // this flag tells the persist step to nudge imagePrompt to a different
  // composition/angle so the two frames aren't identical.
  secondVisual?: boolean;
  // True when this block absorbed a following short sentence
  // (mergeShortVisualSegments). Its script now covers MULTIPLE sentences but
  // its imagePrompt is still the first sentence's, so the planner regenerates
  // one combined imagePrompt for the merged script before persist.
  needsPromptRegen?: boolean;
}

// Shared single-subject / no-text rule (client requirement 2026-06). Used by
// BOTH the full planner prompt and the per-segment prompt regenerator so they
// produce identically-clean prompts. nano-banana was drawing multi-subject
// collages (read as a "split image") and burning text/captions into frames.
// SHOW WHAT THE LINE IS ABOUT (client 2026-08-25, Loom).
//
// The complaint, in his words, with the shot we actually produced:
//   "this mower that cost eight hundred dollars"  -> we showed GLOVES
//   "it's talking about an email"                 -> we showed a letter
//   "when he says mugs, you should show mugs"     -> we showed something else
//   "the script is talking about retained water"  -> we showed no water
// and the reference channel he holds up as correct: "flour in the bin" is a bin
// with flour in it; "she made her own cookbook" is a cookbook; "tomato gravy
// over a biscuit" is tomato gravy over a biscuit.
//
// So the standard is literal depiction of the named thing, and it was NOT a
// model failure -- two rules in this file were instructing the model away from
// it (contextVarietyRule's one-in-three quota, and the DIFFERENT SCENE block's
// "do not reuse the subject"). Both are now scoped so that neither can change
// WHAT the shot is of. This rule is the one that outranks them, and it is
// placed before them deliberately.
const SCRIPT_MATCH_RULE =
  "SHOW WHAT THE LINE IS ABOUT (critical, the client's first requirement): when " +
  "this block's narration names a CONCRETE THING — an object, a place, a " +
  "creature, a person, an action, a document — the imagePrompt MUST show THAT " +
  "THING as the subject of the frame. If the line says mugs, show mugs. If it " +
  "says an email, show the email. If it says water, show water. If it says a " +
  "mower that cost eight hundred dollars, show the mower. " +
  "THE TEST: a viewer who hears this line while looking at this picture must " +
  "see the connection instantly, with nothing to work out. A shot that is " +
  "merely in the same WORLD as the line (its setting, its mood, a nearby or " +
  "related object) is WRONG and is the single thing the client rejects hardest " +
  "— gloves for a line about a mower, a letter for a line about an email. " +
  "Pick the MAIN thing the sentence is about, not a detail at its edge: if the " +
  "line is about what someone paid for a machine, the shot is the machine. " +
  "This rule outranks the VIDEO SUBJECT / NICHE: when the line's concrete thing " +
  "is OUTSIDE the video's niche (a car in an airplane video, a factory process " +
  "in a product video), show the line's thing, not the niche's subject. " +
  // A LINE CAN NAME A PROCESS INSTEAD OF AN OBJECT (client, 2026-09-01: "like
  // enzymes, you can show a footage that enzymes are killing something or
  // scientists have studied this, then you show footage of like scientists
  // studying food"). The old wording sorted every line into "names a concrete
  // thing" or "abstract -> invent from the niche", and a line about enzymes
  // degrading flavour compounds fell in the second bucket, so it rendered
  // another static niche object. But that line is not abstract at all: it
  // describes something that HAPPENS, and what happens is filmable. Naming the
  // process, the mechanism, or the people who study it as depictable subjects
  // is what turns those lines into footage instead of another product shot.
  "A PROCESS IS A CONCRETE THING. When the line describes something HAPPENING " +
  "rather than an object sitting still — a reaction, a mechanism, decay, " +
  "ripening, absorption, a change over time — or describes research, testing or " +
  "measurement, that IS the shot: show the process ITSELF (the food visibly " +
  "breaking down, mould spreading, a tomato going soft, ice crystals forming, " +
  "starch turning sugary, steam or condensation) or the PEOPLE doing the work " +
  "(a researcher examining produce in a lab, a technician measuring a sample, " +
  "hands testing a piece of fruit). Do NOT fall back to a static shot of the " +
  "object the process acts on — that is the same picture the video has already " +
  "shown, and it is why footage repeats. " +
  "Only when a line names NO depictable thing OR process at all (pure " +
  "commentary, a transition, a rhetorical aside) may you invent a visual — and " +
  "then prefer whatever the surrounding sentences are physically about, or the " +
  "wider real-world context the narration invokes (where the thing comes from, " +
  "who handles it, where it is grown, sold, made or studied), not another " +
  "close-up of the niche's main object.";

// HANDS ARE NOT A SUBJECT (client, repeatedly: "What is this hand movement?
// Every time it like uses it on the hand movement, it doesn't make any sense",
// and "why the all clip is ther hands?").
//
// Measured 2026-08-26 on a live plan: five CONSECUTIVE blocks all resolved to
// "a person's hand + a ground turkey package + a label". Their pairwise word
// overlap was 0.24-0.52, so the scene-dedupe pass could not see them as repeats
// at any usable threshold -- they are the same PICTURE described five ways.
//
// Every hands rule in this codebase before today governed MOTION (what moves in
// a clip). Nothing governed COMPOSITION, and brollObjectRule was actively asking
// for "hands-on B-roll". So the model was following instructions.
//
// This rule is about the still. It is deliberately blunt: "a hand holding X" is
// the single most repeated composition in our output, and naming it as forbidden
// is what stops it being the default answer for every object line.
const HANDS_RULE =
  "HANDS ARE NOT A SUBJECT (critical, client requirement): do NOT make a hand, " +
  "hands or fingers the subject of the picture. 'A hand holding X', 'a hand " +
  "pointing at X', 'hands reaching for X' are FORBIDDEN compositions — they are " +
  "the most over-used shot in our videos and the client has rejected them by " +
  "name. " +
  "When the line is about an OBJECT, show the OBJECT: on the shelf, on a " +
  "counter, in a cart, beside its price tag, in use, in its real place. When the " +
  "line is about a PERSON, show the PERSON — their body and face in frame, doing " +
  "the thing. " +
  "A hand may appear ONLY when the line is genuinely about a hand action " +
  "(opening it, pouring it, picking it up), and even then frame the PERSON doing " +
  "it rather than a disembodied hand. If you are about to write 'a hand', ask " +
  "what the line is really about and show that instead.";

// A PERSON LOOKING AT THE THING IS NOT A SHOT (client 2026-08-27: "the clip
// that people seeing gun is appeared at many times", and for a different video
// "the clip that people seeing computer").
//
// MEASURED on the two projects the client watched:
//
//   Gun       266 blocks   person EXAMINING a thing   79  (30%)
//   Mountain  167 blocks   person AT A SCREEN + EXAMINING  45  (27%)
//
// This is the "constantly someone holding a computer on a mountain" complaint
// arriving by a different route, and every guard we have is blind to it. Scene
// dedupe compares NOUNS and each of these names a different one (rifle,
// receiver, stock, barrel). The match gate judges each block ALONE, and a
// person examining a rifle genuinely does match a line about a rifle — so it
// passes, every time. Contents and SHAPE are different axes.
//
// Same treatment that worked on HANDS_RULE: name the over-used composition,
// forbid it as the default, and say what to do instead. Hands were the
// dominant shape before that rule and are 5% after it.
//
// Not a ban — inspecting IS the event in a line about checking a serial number.
// The rule is that it must be what the line is about, not the fallback for
// every line that mentions an object.
const EXAMINING_RULE =
  "SOMEONE LOOKING AT THE THING IS NOT A SHOT (critical, client 2026-08-27): " +
  "a person examining, inspecting, studying, peering at, holding up to the " +
  "light, or looking at a screen showing the subject is the single most " +
  "over-used composition in our videos — measured at 30% of one video and 27% " +
  "of another. The client has now reported it twice, in two unrelated videos. " +
  "Use it ONLY when the line is genuinely ABOUT inspection: checking a serial " +
  "number, spotting a fake, reading a mark. Never as the answer to a line that " +
  "merely mentions an object. " +
  "When you catch yourself writing 'a person examining X', 'a collector " +
  "inspecting X', 'looking closely at X', or 'studying a screen showing X', " +
  "stop and ask what is actually HAPPENING in the line, then show that " +
  "instead: the thing being used for its purpose, carried, sold, packed, " +
  "argued over, made, worn out, or in the place it belongs with people going " +
  "about their business around it. If the line has no event at all, show the " +
  "thing in its world — not a person peering at it. " +
  "The same goes for the opposite default: the object ALONE on a workbench, " +
  "counter or cloth, with nobody present. Between them, a person peering at " +
  "the subject and the subject lying on a surface accounted for more than half " +
  "of a recent video. Across any run of five blocks, at most ONE may be either.";

// WHAT HAPPENS OUTRANKS WHAT IS MENTIONED (client 2026-08-26).
//
// "The script is saying a collector drove four hours. Why are you showing a gun?
// You should show someone driving." And: "the script is saying the firearms were
// built. You should show someone building a gun."
//
// MEASURED on three live plans -- of the lines where a person DOES something:
//
//   Old Guns   89 action lines ->  12% a person doing it,  75% an object
//   test1     108 action lines ->  10% a person doing it,  74% an object
//   turkey     18 action lines ->   0% a person doing it,  56% an object
//
// The client's exact example is in the data: "A collector drove four hours to
// get there. He paid the eight hundred, loaded the truck" was planned as "a
// close-up of a vintage firearm resting on a velvet-lined shelf".
//
// The cause is that every subject rule here points at NOUNS. brollObjectRule
// requires the named OBJECT to be the single subject; SCRIPT_MATCH_RULE's
// examples are all objects. Nothing said a VERB outranks a noun, so a line about
// a person driving, next to a video about guns, resolves to a gun.
//
// Placed ABOVE the object rules deliberately: it decides whether this line is
// about an event at all, and only when it is not do the object rules apply.
const ACTION_FIRST_RULE =
  "WHAT HAPPENS OUTRANKS WHAT IS MENTIONED (critical, the client's clearest " +
  "requirement): read this block's line and ask FIRST — does something HAPPEN in " +
  "it? Does a person do something, go somewhere, make, build, buy, sell, carry, " +
  "open, find, choose or hand over anything? " +
  "If yes, THAT EVENT is the picture, and a person performing it must be in " +
  "frame. 'A collector drove four hours' is someone DRIVING — a person at the " +
  "wheel on a long road, not the thing they were driving to. 'The firearms were " +
  "built' is someone BUILDING — hands and body at a workbench, tools, parts, work " +
  "in progress. 'He loaded the truck' is a person LOADING A TRUCK. " +
  "Showing the object the sentence happens to mention, instead of the event, is " +
  "the single most common mistake in our videos and the client rejects it every " +
  "time: a static object where the line described a person acting. " +
  "The object still belongs in the frame — as what is being driven to, built, " +
  "loaded or sold — but it is NOT the subject. The person and the action are. " +
  "Only when a line genuinely has NO event in it (a fact, a number, a " +
  "description of a thing) do the object rules below decide the subject.";

// WHO THE SENTENCE IS ABOUT IS NOT ALWAYS A THING YOU CAN HOLD (2026-08-26).
//
// MEASURED on the client's own review script (the "Old Guns" manufacturing
// passage), planning every line through the rules above:
//
//   "Then came the acquisitions."          -> a person placing a rifle in a case
//   "The consolidations."                  -> boxes of firearm parts on a shelf
//   "Winchester was sold."                 -> a person wiping down a Winchester
//   "Colt changed hands more than once."   -> a person examining a Colt
//
// Every one of those lines is about a COMPANY -- an acquisition, a corporate
// sale, an ownership change. None is about a gun. But ACTION_FIRST_RULE sees a
// verb ("sold", "changed hands") and pictures a person physically doing that to
// the product, and the niche supplies the product. The result is the client's
// complaint in its purest form: the script talks business, we show another gun.
//
// This is a MEANING failure, not a matching failure -- the picture does contain
// a word from the sentence. So it sits immediately after ACTION_FIRST_RULE: it
// decides WHAT KIND of thing the sentence is about before the action and object
// rules decide how to frame it.
const INSTITUTION_NOT_PRODUCT_RULE =
  "AN ORGANISATION IS NOT ITS PRODUCT (critical): before choosing the picture, " +
  "ask WHAT the sentence is actually about — a physical thing someone can hold, " +
  "or a COMPANY, an industry, an era, a market, a regulation, an ownership " +
  "change? " +
  "When the subject is a company or an industry, showing one specimen of what it " +
  "makes is WRONG. A maker being SOLD is a business changing owners, not someone " +
  "handling the product. 'Then came the acquisitions' is companies buying " +
  "companies. 'The consolidations' is an industry shrinking. 'Shareholder " +
  "pressure' is a boardroom, not a craftsman. This holds in every field: a " +
  "carmaker, a studio, a bakery chain, a label, a publisher, a factory — when " +
  "the sentence is about the ORGANISATION, one more photograph of what it sells " +
  "is the wrong picture. " +
  "For these lines the picture is the INSTITUTIONAL world, chosen to fit THIS " +
  "video's own subject: a signed agreement or contract on a desk, a boardroom or " +
  "office meeting, a factory floor and its workers, a production line, a company " +
  "building or its gates, an empty or closing plant, ledgers and paperwork, a " +
  "handshake between people in business clothes, a newspaper business page. Show " +
  "PEOPLE doing the business wherever you can. " +
  // HOW IT WAS MADE IS NOT THE FINISHED THING (2026-08-26, same live plan).
  // "a number of manufacturers were producing firearms to a standard of fit,
  // finish and mechanical integrity" is a line about an INDUSTRY AND A PROCESS,
  // and it produced six consecutive close-ups of a finished gun being cleaned,
  // oiled, blued and polished on one bench. The subject of the sentence is how
  // the things were MADE, and the making has factories, machines and people in
  // it — none of which appeared.
  "MAKING IS NOT THE MADE THING: when a line is about how something was " +
  "produced, built, assembled, inspected or finished — its standards, its " +
  "tolerances, its materials, the labour in it — the picture is the MAKING. " +
  "Show the factory floor, the machine mid-cut, the bench with work in " +
  "progress and a worker at it, the inspection, the parts before they are a " +
  "product, the people who did it, the building they did it in. A polished " +
  "finished specimen being handled, cleaned or admired is the WRONG picture " +
  "for these lines, and a run of them is what makes a video feel like one long " +
  "product shoot. Only when the line is specifically about how the finished " +
  "thing LOOKS does the finished thing become the subject. " +
  "Likewise read FIGURES OF SPEECH for their meaning, not their words: someone " +
  "who 'cleaned out' a cupboard EMPTIED it (they did not wipe it with a cloth); " +
  "something that 'changed hands' was SOLD; a market that 'dried up' lost its " +
  "buyers; a person who 'walked away' QUIT. Picture what the sentence MEANS. " +
  "The examples above are a METHOD, not wording to reuse — the nouns in your " +
  "prompt must come from THIS video's subject and THIS block's line, never from " +
  "this rule.";

// THE SUBJECT LIVES SOMEWHERE (client 2026-08-26: "I know the script is about
// guns, but all we do is show footage about guns ... it's just random showing
// guns").
//
// MEASURED across two live plans, every visual block classified:
//
//                              Old Guns      test1
//   a person in frame              9%          8%
//   hands only                     8%         11%
//   the object ALONE, no place    80%         79%
//   the object in a real place      3%          2%
//
// So ~87% of a video is the topic object on a surface, with no one present and
// nowhere in particular. Every one of those blocks MATCHES its line -- the line
// is about the object and the picture is the object -- and the result is still
// three hundred near-identical close-ups. Matching and monotony are different
// failures, and fixing the first does not touch the second.
//
// The resolution of the tension that has whipsawed this file all week: VARY THE
// SITUATION, NEVER THE SUBJECT. The 2026-07 context rule failed because it let
// the model show a DIFFERENT OBJECT for variety ("$800 mower" -> gloves). This
// keeps the named subject in every frame and moves it through the world instead.
const SUBJECT_IN_THE_WORLD_RULE =
  "SHOW THE SUBJECT IN THE WORLD, NOT ON A VELVET CUSHION (critical, client " +
  "requirement): the thing this line is about must be in the picture — but it " +
  "must be SOMEWHERE, in a real situation, not floating alone on a surface. " +
  "Measured on our own output, ~80% of blocks were the topic object 'resting on' " +
  "something with no person and no place around it, and the client's summary was " +
  "'it's just random showing guns'. " +
  "DEFAULT TO A SITUATION: the thing where it actually lives and is actually " +
  "used — on a shop counter, in a case among others, in a cardboard box being " +
  "packed, on a workbench mid-repair, in the back of a car, at a fair or market " +
  "stall, in a drawer being opened, on a kitchen table beside the post, in " +
  "someone's arms, in the room of the person who owns it. " +
  "A bare 'product shot' — the object centred on a plain, velvet, dark or " +
  "neutral surface — is allowed ONLY when the line is specifically about how the " +
  "object LOOKS (a marking, a serial number, a finish, a defect). Everywhere " +
  "else it is the lazy answer and it is what makes our videos monotonous. " +
  "Consecutive blocks about the same subject MUST move it: different place, " +
  "different moment, different company, different scale. The subject never " +
  "changes; the situation always does. " +
  // PEOPLE, 2026-08-26. Re-planning randomly sampled real lines with the
  // situation rule alone left ten of twelve frames as the object on a surface --
  // now a surface somewhere, but still no one present. The client's reference
  // channel is mostly PEOPLE DOING THINGS, and his instruction was "you should
  // show someone building a gun or like trying to". A story about a thing is
  // told through the people around it: who owned it, sold it, drove to get it,
  // missed what it was worth.
  //
  // NOT a return to the stock people rejected in June -- those were posed beside
  // the subject doing nothing. The test is whether the person is DOING something
  // the line implies.
  "MOST SHOTS SHOULD HAVE A PERSON IN THEM. This script is a story about " +
  "people — who owned this thing, who sold it, who bought it, who missed what it " +
  "was worth — and a video of objects on tables tells none of it. Unless the line " +
  "is specifically about a marking, a measurement or a physical detail, put the " +
  "person whose story this line belongs to IN THE FRAME, doing something " +
  "plausible: examining it, carrying it, packing it, selling it across a counter, " +
  "showing it to someone, walking away from it, opening the cabinet it has sat in " +
  "for forty years. " +
  "They must be DOING something — a person standing posed beside the subject is " +
  "the stock-photo look the client rejected before, and is just as wrong as an " +
  "empty table.";

const SINGLE_SUBJECT_RULE =
  "SINGLE SUBJECT (critical, client requirement): the imagePrompt MUST " +
  "describe ONE single photographic scene with ONE clear subject that fills the " +
  "whole frame. NEVER describe a collage, split-screen, grid, diptych, side-by-" +
  "side comparison, before/after, or multiple separate scenes in one image, and " +
  "NEVER ask for any text, caption, label, sign, calendar, or written words in " +
  "the picture. One block = one clean single photo of one subject. " +
  "SCOPE: this rule governs the CONTENT of one generated still only — it does " +
  "NOT discourage the 'split_2' blockType. split_2 is a player-side LAYOUT " +
  "(a talking presenter beside a separate illustrative still, composited at " +
  "render time), NOT a collage drawn inside one image, so keep choosing split_2 " +
  "whenever the narration calls for it; its imagePrompt still follows this rule " +
  "(one clean single-subject still for the illustrative half). " +
  // Client requirement 2026-07 (space/Voyager regen): the model kept showing the
  // subject as a PICTURE OF A PICTURE — a galaxy on a TV/monitor mounted on a
  // wall, a scientist drawing the sun on a whiteboard, a diagram on a screen —
  // instead of the real thing. Those read as "a screen/office again", the exact
  // thing the client rejected, and the whiteboard/diagram also smuggles text
  // back in. The still must BE the scene, not a depiction of it.
  "DIRECT SCENE, NOT A DEPICTION (critical, client requirement): show the real " +
  "subject ITSELF, filling the frame as if photographed on location — NOT the " +
  "subject shown on a screen, TV, monitor, projector, phone, computer, framed " +
  "picture, poster, whiteboard, chalkboard, diagram, map, or as an illustration/" +
  "sketch/painting/hologram. For a space line show actual space (the planet, the " +
  "spacecraft, the star field), never a galaxy on a wall-mounted screen or a " +
  "scientist drawing it on a board. A screen/monitor/whiteboard may appear ONLY " +
  "when the narration is literally about that device or about someone working at " +
  "it. " +
  // Client requirement 2026-07: when the narration names a real/famous/private
  // person (e.g. "Louise Brown"), naming them in the imagePrompt makes the
  // image/video provider REFUSE or STALL the job (real-likeness hard-blocks), and
  // a named private individual's likeness is never reliably reproduced anyway. So
  // the picture prompt must describe people GENERICALLY by visual traits, never by
  // name. The SPOKEN narration keeps the name — only the imagePrompt is de-named.
  "NO REAL NAMES (critical, client requirement): NEVER put a real person's name " +
  "— famous, private, or public-figure — in the imagePrompt, and never give an " +
  "unmistakable identifying description of one specific real individual. If the " +
  "narration names someone, describe them GENERICALLY by the visual traits the " +
  "scene needs: approximate age, gender, era-appropriate clothing, setting, mood, " +
  "action. Example: NOT 'Louise Brown with her two sons' but 'an elderly woman " +
  "with two grown adult sons, smiling together in a 1970s family home, warm " +
  "nostalgic tone'. The spoken script is unchanged — the name stays in the " +
  "voiceover; only the picture prompt is de-named.";

// The video's derived niche/world. Filled by deriveVideoTopic() from the
// project title + a transcript sample so the planner prompt anchors visuals to
// the ACTUAL subject of the video (car maintenance, cooking, finance, gardening,
// …) instead of the previously-hardcoded gardening/lawn-care niche. Every field
// may be empty — when the whole topic is empty the rule builders below fall back
// to niche-neutral phrasing so nothing regresses to a fixed domain.
export interface VideoTopic {
  // Short human niche label, e.g. "automotive / DIY car maintenance".
  niche: string;
  // Recurring physical setting, e.g. "home garage / driveway, under the hood".
  setting: string;
  // A few example on-topic subjects, e.g. "spark plugs, engine bays, hand tools".
  subjectExamples: string;
  // Wider real-world context/action scenes of the niche — the subject in use or
  // in motion in its environment, e.g. "utes driving on highways, vehicles on
  // outback roads" for an engine video. Feeds the context-variety rule so the
  // visuals aren't ONLY literal close-ups of the narrated object (client
  // feedback 2026-07: an engine video should also show cars driving as B-roll).
  environmentExamples: string;
  // Narration language (projects.language). Carried on the topic rather than
  // passed as a second argument because `topic` is ALREADY threaded through
  // every prompt builder and chunk planner — so the language reaches all of
  // them with no signature churn, and it cannot be forgotten on one path.
  //
  // It belongs here conceptually too: the language decides WHERE the video's
  // world is (a German script gets European streets, homes, and cars), which is
  // exactly what the rest of VideoTopic describes.
  language: LanguageCode;
}

const EMPTY_TOPIC: VideoTopic = {
  niche: "", setting: "", subjectExamples: "", environmentExamples: "",
  language: DEFAULT_LANGUAGE,
};

// Topic emptiness is about the NICHE only — `language` always has a value and
// must not make an otherwise-empty topic look derived.
function hasTopic(t: VideoTopic): boolean {
  return Boolean(t.niche.trim() || t.setting.trim() || t.subjectExamples.trim() || t.environmentExamples.trim());
}

// Object-first B-roll rule (client requirement 2026-06). The reference channel
// reads as the creator filming his OWN scene, not a stock library: when the
// narration names a THING, the screen shows THAT thing (script says "water" ->
// show water; "clogged gutter" -> show the gutter; "spark plug" -> show the
// plug; "engine" -> show the engine bay), NOT a person. Our earlier output
// leaned on people (an old lady / an old man / the presenter) for lines that
// were really about objects, which read as generic stock footage. So the
// DEFAULT subject is the concrete object, tool, or place the line is about —
// shoot it close, hands-on B-roll, owner's-own-project feel. Only put a PERSON
// in frame when the narration is genuinely about a person or a first-person
// action; never as filler for an object-focused line. The subject/setting
// examples are derived from the video's actual topic (VideoTopic) so this rule
// stays on-niche for ANY channel instead of the old hardcoded garden wording.
function brollObjectRule(topic: VideoTopic): string {
  const settingPhrase = topic.setting.trim()
    ? `their own ${topic.setting.trim()}`
    : "their own real setting for this video";
  const examplePhrase = topic.subjectExamples.trim()
    ? `— e.g. ${topic.subjectExamples.trim()}, a tool, water, a part, a surface, etc. —`
    : "— a tool, a part, an object, a place, etc. —";
  // "hands-on B-roll" was in the prompt for EVERY visual block of every video,
  // which is part of why 11-17% of blocks across four audited projects put a
  // disembodied hand in frame. The intent was "candid, close, real" -- say that.
  const brollPhrase = topic.setting.trim()
    ? `close, candid B-roll of the real object in ${topic.setting.trim()}`
    : "close, candid B-roll of the real object in the video's own setting";
  return (
    // Scoped 2026-08-26: this rule decides the subject only for lines with no
    // event in them. ACTION_FIRST_RULE handles the rest, and saying so here stops
    // the two rules fighting over a line like "a collector drove four hours".
    "REAL B-ROLL FOR LINES WITH NO ACTION IN THEM (client requirement): when " +
    "this line simply describes or names a thing — no one doing anything — " +
    "this is an " +
    `owner filming ${settingPhrase}, NOT a stock-photo library. When the narration ` +
    `names a concrete OBJECT ${examplePhrase} the imagePrompt MUST show THAT thing ` +
    `as the single subject (${brollPhrase}). Do NOT pad an object line with a ` +
    "person who is just standing there ('an elderly woman', 'a man') — that is " +
    "the generic stock look the client rejects. " +
    // 2026-08-25: the old wording read "OBJECTS NOT PEOPLE" and banned people by
    // default, which was over-read into every clip being disembodied hands. The
    // reference channel the client holds up as correct is full of people DOING
    // things -- a mother at a pantry, someone cooking. A person doing the thing
    // the line describes is not stock footage; a person loitering beside it is.
    "But when the line IS about a person, or about someone DOING something, SHOW " +
    "THAT PERSON doing it — a whole person in frame, working, not a pair of " +
    "disembodied hands. If the line is about someone being told something, show " +
    "them being told (on the phone, in conversation, reading the letter). People " +
    "acting out what the narration describes are exactly what we want; people " +
    "posed beside it are not."
  );
}

// Context-variety rule (client feedback 2026-07), RESCOPED 2026-08-25.
//
// Its original job stands: an engine video should not be wall-to-wall engine
// bays, so the niche's wider world — the subject in use, in motion, in its real
// environment — belongs on screen too.
//
// What it must no longer do is DECIDE THE SUBJECT. It used to read "do NOT make
// every visual a literal close-up of the exact object the narration names ...
// roughly one in three MUST instead show the niche's WIDER real-world context",
// which is a standing instruction to ignore the script on a third of all blocks.
// That is where "$800 mower -> gloves" comes from: the model was doing what this
// rule told it to. Variety is now expressed as a choice of SHOT (angle, scale,
// moment, whether the thing is in use), never as a licence to show something
// else. See SCRIPT_MATCH_RULE, which outranks this.
//
// The environment examples come from deriveVideoTopic() so this stays generic
// for any niche; when the topic is empty the phrasing stays niche-neutral.
function contextVarietyRule(topic: VideoTopic): string {
  const envPhrase = topic.environmentExamples.trim()
    ? `(e.g. ${topic.environmentExamples.trim()})`
    : "(the thing being used, driven, cooked, grown, worn… out in its real environment)";
  return (
    "SHOT VARIETY (client requirement): vary HOW you show things, so the video " +
    "does not read as the same framing over and over. Change the scale and the " +
    "moment: a close-up of the thing, the thing being used or handled, the thing " +
    `out in its real environment ${envPhrase}, a wide shot of the place it lives ` +
    "in. Prefer the in-use and wider framings for imagePrompt2 second visuals and " +
    "for wide/establishing shotTypes. " +
    "STRICT LIMIT — this rule NEVER changes WHAT is in the frame: when the line " +
    "names a concrete thing, that thing is the subject no matter which framing " +
    "you pick (see SHOW WHAT THE LINE IS ABOUT, which outranks this rule). " +
    "Showing an unrelated object for the sake of variety is the worst outcome " +
    "available, far worse than two similar shots in a row. " +
    "Only for lines that name NOTHING concrete may you fall back to a pure " +
    "context shot of the niche's wider world."
  );
}

// Amateur-real look rule (client requirement 2026-06). Even though the phone-shot
// STYLE_PROMPT is appended at generation time, Gemini tends to slip cinematic
// words into the scene prompt ("cinematic", "shallow depth of field", "golden
// hour", "professional photo", "dramatic lighting"), which fight the amateur look
// and bring back the gorgeous-but-fake stock/CGI vibe the client rejected. Forbid
// those here so the scene prompt describes WHAT is shown, never a produced style.
function amateurLookRule(topic: VideoTopic): string {
  const wherePhrase = topic.setting.trim()
    ? `in their own ${topic.setting.trim()}`
    : "in their own real setting";
  return (
    "AMATEUR REAL LOOK (client requirement): describe the scene as if shot by an " +
    `ordinary person on a phone ${wherePhrase}. Do NOT add any cinematic, ` +
    "professional, or stock-photo styling words — NO 'cinematic', NO 'shallow depth " +
    "of field' / 'bokeh' / 'blurred background', NO 'golden hour' / 'dramatic " +
    "lighting' / 'lens flare', NO 'professional photo' / 'award-winning' / '8k'. " +
    "Just describe the real subject and setting plainly; the camera look is added " +
    "separately."
  );
}

// Shot-variety rule (client variety fix 2026-06). The footage all looked the
// same — every still was the same tight close-up — because the prompts changed
// the SUBJECT but never the FRAMING. Each block now picks a `shotType`
// (scale + angle) and consecutive blocks MUST differ, so the video reads as a
// varied edit instead of one repeated shot. shotType describes only camera
// distance/angle, NOT subject and NOT camera-look styling.
const SHOT_TYPES =
  "extreme close-up / macro detail · close-up · medium shot · wide / " +
  "establishing shot · top-down (overhead) shot · low-angle ground-level shot · " +
  "over-the-shoulder shot · product shot (an object presented on a surface)";

// The SAME list as SHOT_TYPES, as data. shotType is a free-text field in the
// planner's JSON, and composePrompt puts it in FRONT of the scene as
// "<shotType>: <scene>" — so whatever Gemini writes there becomes the opening
// words of the image prompt, unvalidated.
//
// MEASURED 2026-08-26 on a Mount Sinai plan: two blocks came back with
// shotType "aerial views of Mount Sinai" — a phrase lifted from the derived
// topic's environmentExamples, not a camera framing at all. Those blocks
// composed to "aerial views of Mount Sinai: A clear, sunny aerial view of
// Mount Sinai…", which is malformed and duplicates the subject. Any project
// whose environmentExamples read like a shot description can hit this.
//
// A shotType we don't recognise is DROPPED rather than repaired: the scene
// itself is always well-formed, and losing a framing hint costs far less than
// prefixing the prompt with a stray phrase.
const SHOT_TYPE_LIST = [
  "extreme close-up / macro detail",
  "close-up",
  "medium shot",
  "wide / establishing shot",
  "top-down (overhead) shot",
  "low-angle ground-level shot",
  "over-the-shoulder shot",
  "product shot",
] as const;

export function normalizeShotType(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase()
    // Drop an explanatory parenthetical: the prompt lists "product shot (an
    // object presented on a surface)" and Gemini sometimes echoes it whole.
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[.:\s]+$/, "")
    .trim();
  if (!s) return null;
  return SHOT_TYPE_LIST.find((t) => t === s) ?? null;
}
const SHOT_VARIETY_RULE =
  "SHOT VARIETY (critical, client requirement): vary the FRAMING across blocks so " +
  "the video is not the same shot over and over. For EVERY image/ai_clip block " +
  "pick a `shotType` from: " + SHOT_TYPES + ". Do NOT use the same shotType on " +
  "two consecutive blocks, and across any run of 4-5 blocks use several DIFFERENT " +
  "shot types — mix scales (some macro, some wide, some overhead) and angles. " +
  "Specifically do NOT default every block to the same tight close-up: only a " +
  "minority of blocks should be extreme close-ups. When a long sentence splits " +
  "into two visuals, give `shotType2` a DIFFERENT framing from `shotType` so the " +
  "two frames don't match. shotType is camera distance/angle ONLY — never put " +
  "subject or film-look words in it.";

// Product / brand exception (client requirement 2026-06, signed off to relax the
// blanket no-text / no-logo ban for product lines ONLY). When the narration is
// genuinely about a specific PRODUCT — a named part, a bottle of oil, a branded
// tool — the client WANTS that product shown: its packaging, label, or a
// brand/company logo may appear. This overrides the otherwise-blanket "NO text /
// NO logo / NO label" rule for that one block only; every NON-product block still
// follows the no-text rule strictly.
//
// SCOPE NARROWED 2026-08-22. As written, this rule told the planner to draw the
// packaging and logo of whatever the line was about — which on a collectibles
// video means a Star Wars blister card or a Pokémon card face, i.e. exactly the
// prompts gpt-image-2 refuses (12 dead blocks; see NAMED_IP_RULE). The client's
// intent was ordinary consumer goods, where showing the label is the whole point
// of the shot. Franchise merchandise is carved back out and handed to
// NAMED_IP_RULE, which draws the same object without naming it.
function productBrandRule(topic: VideoTopic): string {
  const examplePhrase = topic.subjectExamples.trim()
    ? `(e.g. ${topic.subjectExamples.trim()}, a bottle or bag of a named product, a branded tool)`
    : "(e.g. a named part, a bottle or bag of a named product, a branded tool)";
  return (
    "PRODUCT LINES (client requirement): when the narration is genuinely " +
    `about a specific everyday product ${examplePhrase}, SHOW THAT PRODUCT as the ` +
    "single subject — its packaging or label IS allowed and wanted here (prefer a " +
    "'product shot' shotType). This is the ONLY case where text/labels/logos are " +
    "permitted. For every other (non-product) line keep the strict no-text, " +
    "no-label, no-logo rule. " +
    "LIMIT: this covers ORDINARY CONSUMER GOODS only — food, drink, household " +
    "supplies, tools, parts, materials. It does NOT cover licensed or collectible " +
    "merchandise: toys, action figures, dolls, model and die-cast cars, trading " +
    "cards, games, consoles, comics, or anything tied to a film, show, studio, or " +
    "character. For THOSE the NO NAMED BRANDS OR CHARACTERS rule wins outright — " +
    "no name, no logo, no wordmark, no reproduced card or box art; describe the " +
    "object itself instead. When the two rules could both apply, the no-names " +
    "rule always wins: a block that is refused shows the viewer nothing at all."
  );
}

function buildTopicBlock(topic: VideoTopic = EMPTY_TOPIC): string[] {
  // Niche anchor. When we could derive the video's topic from the title +
  // transcript, we tell Gemini the world up front so scenes stay on-theme
  // — the fix for off-topic visuals (a car video that rendered houses & lawns
  // because the planner never knew the niche). When empty, we emit a neutral
  // instruction so nothing regresses to a hardcoded domain.
  //
  // PRECEDENCE (client requirement, 2026-08-26): the niche is a FALLBACK, not
  // a cage. The old wording ("EVERY imagePrompt MUST stay inside this world")
  // sat at the head of the prompt and overrode SCRIPT_MATCH_RULE: a script
  // about guns whose middle section narrates the factory process still
  // rendered wall-to-wall guns, because every off-niche line was pulled back
  // into the niche. The client's reference product plans each part from that
  // part's own text — a car digression in an airplane video shows a car. So
  // the line's own named content outranks the niche; the niche only decides
  // INVENTED visuals for lines with no concrete scene of their own.
  const topicBlock = hasTopic(topic)
    ? [
        `VIDEO SUBJECT / NICHE: ${topic.niche.trim() || topic.setting.trim()}.`,
        topic.setting.trim() ? `Recurring setting: ${topic.setting.trim()}.` : "",
        topic.subjectExamples.trim() ? `On-topic subjects include: ${topic.subjectExamples.trim()}.` : "",
        topic.environmentExamples.trim()
          ? `The niche's wider real-world context is ALSO in-world and on-topic: ${topic.environmentExamples.trim()}.`
          : "",
        "This world is the DEFAULT, not a cage. When a block's line names a",
        "concrete thing, place, process or event OUTSIDE this niche (a car",
        "digression in an airplane video, a factory floor, a courtroom, a",
        "different industry), the imagePrompt MUST show THAT — what the line",
        "says always outranks the niche. Only when a line is abstract or has no",
        "literal scene do you invent a visual, and an INVENTED visual must come",
        "from THIS niche — never introduce houses, lawns, offices, or any",
        "setting the narration itself never brings up.",
        // "an on-topic object, tool, part, or place" used to be the whole of
        // what could be invented, which quietly made every abstract line
        // another product shot of the same few nouns. The niche's world is
        // bigger than its objects: it includes the processes the narration
        // describes, the places the things come from, and the people who grow,
        // sell, handle or study them. Client 2026-09-01 asked for exactly that
        // ("we can even show people, like people holding a tomato" / "scientists
        // studying food"), and it is also the cheapest source of visual variety
        // in a video whose objects repeat by design.
        "THIS NICHE MEANS ITS WHOLE WORLD, not just its objects: the processes",
        "the narration describes (things ripening, breaking down, reacting,",
        "spoiling, being preserved), the places its subjects come from or end up",
        "(a field, a market, a shop, a pantry, a kitchen counter, a lab), and the",
        "PEOPLE who grow, sell, carry, prepare, handle or study them. Prefer one",
        "of those over another close-up of the same object the video has already",
        "shown repeatedly — a video whose every shot is the same few nouns is the",
        "failure this instruction exists to prevent.",
        // When the subject's world is a remote / non-filmable place (space, the
        // deep sea, Antarctica, wilderness, ancient history), the visuals live in
        // THAT place, not at a desk. This is the fix for space/Antarctica videos
        // that collapsed to wall-to-wall 'man in an office on a computer' — an
        // office is NOT the subject's world for these topics.
        "If this subject's world is a place that cannot be filmed at home (space,",
        "the deep sea, Antarctica / the poles, wilderness, ancient history, an",
        "unexplained-mystery topic), the visuals MUST be set in THAT real world",
        "(the planets, the spacecraft, the ice, the ocean, the site) — do NOT",
        "default to a person talking at a desk, on a computer, or in an office. Show",
        "an office/desk ONLY if the narration is genuinely about office or desk work.",
        "",
      ].filter(Boolean)
    : [
        "Read the whole transcript and infer the video's SUBJECT / niche, and use",
        "that world as the DEFAULT. A line that names a concrete thing, place, or",
        "process outside that world must show what IT says — the line's own",
        "content always outranks the inferred niche. When a line is abstract or",
        "has no literal scene, invent a visual from the video's own subject,",
        "never a generic unrelated setting — and read 'the video's own subject'",
        "as its whole world (the processes it describes, the places its subjects",
        "come from, and the people who handle or study them), not just a repeat",
        "close-up of its main object.",
        "",
      ];
  // Home is not a garden. A line about being 'home' / indoors must render the
  // INDOOR living space (kitchen, living room, bedroom, hallway, porch), never a
  // backyard, lawn, or vegetable patch — unless the narration is specifically
  // about gardening or being outdoors. This kept leaking on lifestyle/health
  // videos where frequent 'home' mentions drifted into garden footage.
  topicBlock.push(
    "IMPORTANT: 'home' / indoors means the indoor living space (kitchen, living",
    "room, bedroom, hallway) or its immediate porch/doorway — NOT a garden,",
    "backyard, lawn, or vegetable patch. Only use garden or outdoor-plant imagery",
    "when the line is specifically about gardening or being outdoors.",
    "",
  );
  // REGIONAL LOOK. Placed AFTER the niche so it constrains the derived world
  // rather than replacing it: a German car video is still a car video, filmed
  // in Europe. Empty for English, so English videos are byte-identical to
  // before this block existed.
  topicBlock.push(...visualCultureRule(getLocale(topic.language)));
  return topicBlock;
}

// What the planner is asked to produce. The two modes differ ONLY in how the
// script is presented and how a block declares the narration it covers:
//
//   text      — legacy. Gemini re-emits the narration as each block's `script`,
//               and the caller then searches the word stream for that text to
//               discover when the block is spoken.
//   sentences — align-first. The transcript's sentences are already timed and
//               numbered; a block declares a contiguous INDEX RANGE and never
//               reproduces the narration at all, so nothing has to be searched
//               for afterwards.
//
// Every creative instruction below is shared, so the two paths can't drift
// into producing different-looking videos.
type PlannerPayload =
  | { mode: "text"; transcript: string }
  | { mode: "sentences"; numbered: string; from: number; to: number };

// HOW FAST THE MOTION IN AN ai_clip RUNS.
//
// One definition, shared by the full planner prompt and the single-block
// regenerate, because a block that drifts from the others shows up as a handful
// of clips moving at a different speed from the rest of the video — worse than
// either setting applied uniformly.
//
// The wording is deliberately two-sided. It has to hold BOTH client reports:
//   - 2026-08-22 "the video is quick movement so some issue is happend" — the
//     smear complaint, which is why nothing here asks for speed;
//   - 2026-08-25 "the clips ... do not match at all / very very bad" — which
//     came after the 08-22 fix made the subject stop moving, so the clip was
//     indistinguishable from the still under it.
// "Completes within the clip" is the load-bearing half: it is the only line
// that makes an unmoving result WRONG rather than merely cautious.
const ANIMATION_SPEED_RULE_LINES = [
  // See the note on ACTION_CLIP_RULE: slow the PACE and shrink the ACTION
  // together. Slowing the pace alone is what made the 2026-08-22 clips read as
  // stills and got that wording reverted three days later.
  // See the SLOW-take-three note on ACTION_CLIP_RULE. This is about DISTANCE,
  // not speed: 97% of a shipped project's clips were damped to the point that
  // the client read them as photographs.
  "SOMETHING MUST TRAVEL. The clip is about four seconds behind a camera that",
  "never moves, so the only thing that tells a viewer this is video and not a",
  "photograph is a subject that visibly CROSSES THE FRAME. Describe an action",
  "with real distance in it — someone walking in or out, a hand carrying",
  "something from one side to the other, a lid coming off, a drawer pulled",
  "open, liquid pouring, a door swinging, a vehicle moving through, an object",
  "lifted clear and set down somewhere else — and let it begin and complete",
  "inside the clip.",
  "THE TEST: if the first frame and the last frame could be mistaken for the",
  "same photograph, the clip has FAILED. A fingertip turning a dial, a hand",
  "resting on something, a slight adjustment, eyes moving — all fail it.",
  "Pace is ORDINARY and natural. Never rushed, sudden or jerky (it renders as a",
  "blur), never a slow-motion EFFECT or speed ramp — and do NOT call the action",
  "slow, gentle, careful, deliberate or subtle, because those words shrink the",
  "movement until nothing happens.",
];

function composePlannerPrompt(topic: VideoTopic, payload: PlannerPayload): string {
  const topicBlock = buildTopicBlock(topic);
  const locale = getLocale(topic.language);

  const segmentationIntro =
    payload.mode === "text"
      ? [
          "You are a video director planning the visual track for an AI-generated",
          "narrated video. Segment the transcript below into an ordered list of",
          "visual blocks that play in sync with the narration. Cover the ENTIRE",
          "transcript with no gaps and no overlaps — each block's `script` must be a",
          "contiguous slice of the transcript, and concatenating all blocks' script",
          "in order must reproduce the transcript.",
        ]
      : [
          "You are a video director planning the visual track for an AI-generated",
          "narrated video. The narration has ALREADY been split into numbered",
          "sentences (listed at the end) and each sentence's spoken timing is",
          "already known. Your job is to GROUP those sentences into an ordered list",
          "of visual blocks.",
          "",
          "Each block covers a CONTIGUOUS run of sentence indices, declared as",
          "`startSentence` and `endSentence` (both inclusive; use the same number",
          `for both when a block is one sentence). Cover EVERY index from ${payload.from}`,
          `to ${payload.to} exactly once: the first block starts at ${payload.from}, each`,
          "block starts at the previous block's endSentence + 1, and the last block",
          `ends at ${payload.to}. No gaps, no overlaps, ascending order.`,
          "",
          "Do NOT reproduce the narration text anywhere in your answer — the",
          "sentence numbers are the only reference you need, and the system already",
          "has the words.",
        ];

  const sizing =
    payload.mode === "text"
      ? [
          "Block sizing — ONE SENTENCE = ONE BLOCK. Each block's `script` MUST be a",
          "WHOLE sentence (or a few short, tightly-related sentences). NEVER break a",
          "single sentence across two blocks, and NEVER end a block mid-sentence /",
          "mid-clause — a block always ends at a sentence boundary (. ? !). A long",
          "sentence stays ONE block even if it runs 10-15 seconds; the system covers a",
          "long sentence with multiple visuals automatically, so you do NOT need to",
          "shorten it. Keeping the whole sentence in one block lets you describe a",
          "visual for the COMPLETE thought instead of a fragment.",
        ]
      : [
          "Block sizing — ONE SENTENCE = ONE BLOCK by default. Group two or three",
          "consecutive sentences into one block ONLY when they are short and describe",
          "the SAME visual moment. A long sentence stays its own block even if it runs",
          "10-15 seconds; the system covers a long block with multiple visuals",
          "automatically, so you never need to shorten one. Never group sentences that",
          "would need different pictures.",
        ];

  const responseShape =
    payload.mode === "text"
      ? 'Respond ONLY with JSON: {"basePrompt","segments":[{"blockType","script","imagePrompt","shotType","imagePrompt2","shotType2","extraScenes":[{"imagePrompt","shotType"}],"animationPrompt"}]}'
      : 'Respond ONLY with JSON: {"basePrompt","segments":[{"startSentence","endSentence","blockType","imagePrompt","shotType","imagePrompt2","shotType2","extraScenes":[{"imagePrompt","shotType"}],"animationPrompt"}]}';

  const tail =
    payload.mode === "text"
      ? ["TRANSCRIPT:", payload.transcript.trim()]
      : [
          `NUMBERED SENTENCES (${payload.from} to ${payload.to}):`,
          payload.numbered,
        ];

  // Foreign-language narration: prompts go to English-trained image/video
  // models, so they must come back in English. `script` is the ONE exception —
  // in text mode it is a verbatim slice of the transcript that the caller then
  // searches for in the word stream, so translating it would break alignment
  // outright. Empty for English.
  const languageRule = promptLanguageRule(locale);
  const scriptExemption =
    languageRule.length > 0 && payload.mode === "text"
      ? [
          "EXCEPTION: each block's `script` is a VERBATIM slice of the transcript and",
          `MUST stay in ${locale.promptName}, copied exactly. Only the prompt fields are English.`,
          "",
        ]
      : [];

  return [
    ...languageRule,
    ...scriptExemption,
    ...topicBlock,
    ...segmentationIntro,
    "",
    "For each block choose exactly one blockType:",
    "  - avatar : emotional, personal, or first-person statements (a person",
    "             talking to camera).",
    "  - image  : explanations / factual exposition best shown with a still.",
    "  - ai_clip: action or dynamic scenes that benefit from motion.",
    "  - split_2: a talking presenter beside an illustrative image, shown",
    "             together. CHOOSE THIS BASED ON THE CONTENT: use it whenever the",
    "             narrator is personally explaining, walking through, or",
    "             commenting on something the viewer should ALSO see beside them",
    "             (e.g. 'here's what I mean…', 'look at this…', a tip the presenter",
    "             demonstrates). It is a normal, useful layout — pick it naturally",
    "             wherever it fits the script, the same way you pick image or",
    "             ai_clip. The only limit: it should not DOMINATE the video (don't",
    "             make it the majority of blocks); a varied mix of all four types",
    "             is the goal.",
    "",
    ...sizing,
    "",
    "FIRST, read the WHOLE transcript and write a single `basePrompt`: the",
    "video's recurring visual world — the SETTING / location type, the era, and",
    "the overall mood ONLY. This is a shared style bible that every block builds",
    "on, added as trailing context to each block. Keep it SHORT (one sentence).",
    // 2026-08-26. This block used to end with "Name at most ONE kind of place,
    // and never two joined with 'and'" — which contradicts its own worked
    // example ("an ordinary American home AND the shops around it"). Given a
    // rule and an example that disagree, the model obeyed the rule and picked
    // the NARROWEST single room it could: a live plan came back with "a
    // collector's private armory, present day, well-lit and organized", and
    // every placeless block in a script about estate sales, a four-hour drive,
    // a truck bed, a factory floor and a boardroom inherited that one room.
    //
    // A recurring WORLD is the right idea; a recurring ROOM is the failure. So
    // the requirement is inverted: name the kind of place AND what surrounds it.
    "Keep it GENERAL — a WORLD, not a room. Name the kind of place AND the",
    "everyday places around it, so blocks that leave the main setting still have",
    "somewhere to be. 'an ordinary American home and the shops around it,",
    "present day, warm and plain' is right, and so is 'workshops, gun shops,",
    "estate sales and the roads between them'. A single named room is WRONG —",
    "'a collector's private armory' or 'a brightly lit supermarket meat aisle'",
    "means every block in the video happens in that one room no matter what its",
    "own line is about, which is the most common cause of a monotonous video.",
    "Never a possessive, private or one-off location ('a collector's private X',",
    "'the workshop of a master Y'): those are a single room wearing a costume.",
    "If the transcript travels — a journey, a sale, a factory, an office, a",
    "different decade — the world must be broad enough to contain all of it.",
    "Do NOT bake in a fixed framing or composition (do NOT say 'close-up' or",
    "one repeated shot here) and do NOT name one specific subject — the",
    "framing comes from each block's shotType and the subject from each block's",
    "imagePrompt, both of which MUST vary block to block. Do NOT include camera or",
    "film-grain styling — that is appended separately.",
    // The basePrompt is appended to EVERY block, so a drifted base poisons the
    // whole video. For a non-filmable subject (space, deep sea, Antarctica, …)
    // the model kept inventing an earthbound ROOM for the 'recurring setting' —
    // e.g. 'a 1970s NASA mission control center', 'a dim server room' — which
    // then dragged every block into that room. The recurring WORLD for these
    // subjects IS the subject's real environment, not a control room / office /
    // studio the footage is 'presented' from.
    "IMPORTANT — the basePrompt's SETTING: if this video's subject cannot be",
    "filmed in a home/office/studio (space, the deep sea, Antarctica / the poles,",
    "wilderness, ancient history, an unexplained mystery), the recurring setting",
    "MUST be that real subject world itself (e.g. for a space video: 'deep space,",
    "planets and star fields, the spacecraft among them'), NOT a mission-control",
    "room, server room, laboratory, office, or studio the subject is merely",
    "observed or narrated from. Do NOT put a control room / desk / screens in the",
    "basePrompt unless the video is literally about that room.",
    "",
    "THEN segment the transcript. For EVERY image/ai_clip/split_2 block, write a",
    "concrete `imagePrompt`: ONLY the scene-specific detail for THIS block (the",
    "action, the specific subject and composition of this moment). Do NOT repeat",
    "the basePrompt — assume it is already present. Do NOT include camera or",
    "film-grain styling.",
    "",
    "CRITICAL — the imagePrompt is a PICTURE DESCRIPTION, never the narration.",
    "NEVER copy, paraphrase, or echo the block's `script` into the imagePrompt.",
    "The script is what is SPOKEN; the imagePrompt is what is SHOWN — they are",
    "different things. Every visual block MUST have a non-empty imagePrompt that",
    "describes a real, filmable scene set in the video's world (the basePrompt).",
    "When a line is conversational, abstract, or filler (e.g. 'Be honest, I read",
    "these.', 'the August Panic Method', 'and we are going to fix it') and has no",
    "literal scene, INVENT an on-topic visual that fits the recurring world",
    "(e.g. the presenter in the relevant setting, a relevant object or B-roll of",
    "the subject) — do NOT leave imagePrompt empty and do NOT fall back to the",
    "spoken words. An empty imagePrompt is INVALID output.",
    "",
    "SECOND VISUAL — also write an `imagePrompt2` for EVERY image/ai_clip block.",
    "A long sentence is shown with TWO visuals, so imagePrompt2 is a SECOND,",
    "genuinely DIFFERENT picture of the SAME sentence — a different subject, a",
    "different moment, or a different detail of this same thought (e.g. if",
    "imagePrompt is a close-up of the main object, imagePrompt2 might show a",
    "related detail beside it, or a wide shot of the whole scene). It MUST NOT be the",
    "same scene as imagePrompt with only a reworded angle — make it a DISTINCT",
    "shot so the two visuals never look like duplicates. It follows ALL the same",
    "rules as imagePrompt (picture-not-narration, single-subject, B-roll objects,",
    "amateur look) and gets its own `shotType2` with a DIFFERENT framing than",
    "shotType. If you genuinely cannot think of a second distinct on-topic scene,",
    "you may leave it empty and the system will vary the first one.",
    "",
    // CUT ON PHRASES, NOT SENTENCES (client "Joey", 2026-09-03, comparing our
    // output against a reference video he sent). His whole complaint reduces to
    // one observation: in the reference, EVERY named thing gets its own shot —
    // "grocery store" -> a grocery store, "the bacon, the chicken" -> bacon and
    // chicken, "my barn" -> a barn, "saves money" -> a wallet of cash. In ours a
    // long sentence held ONE subject for its whole run, because imagePrompt /
    // imagePrompt2 cover at most two slots and every slot after that re-rendered
    // slot 1 with a "different angle" nudge. Four slots, one idea, so the video
    // reads as the same footage repeating.
    //
    // His words: "The logic is based on the context of the script, but it should
    // go into the details of the script more."
    //
    // A sentence is split into ceil(duration / ~4s) slots downstream, so a 14s
    // sentence needs FOUR scenes and gets four only if they are asked for here.
    "EXTRA SCENES — for a LONG sentence (roughly 10 seconds or more, or one that",
    "names three or more different concrete things), also write `extraScenes`: an",
    "ordered array of {imagePrompt, shotType} for the REMAINING visuals of that",
    "same sentence, after imagePrompt and imagePrompt2. Aim for about one scene",
    "per 4 seconds of narration: a 12-second sentence wants imagePrompt +",
    "imagePrompt2 + ONE extraScenes entry; a 20-second sentence wants about three.",
    "Short sentences need none — leave it out.",
    "WALK THE SENTENCE AND SHOW WHAT IT NAMES, IN ORDER. Each scene takes the",
    "NEXT concrete thing the narration mentions, so the picture changes as the",
    "narration moves. If the line is \"it is not spoiling, not growing mould, it is",
    "just losing the flavour and texture you paid for at the store\", the scenes",
    "are: the food looking fine -> MOULD on food -> the flavour/texture (a cut",
    "surface, a bitten piece) -> the STORE where it was bought. Not four angles on",
    "one fridge.",
    "Every entry follows ALL the same rules as imagePrompt and must be a",
    "DIFFERENT thing from every earlier scene of this block — a re-framing of an",
    "earlier scene is exactly the repetition this exists to remove.",
    "",
    SINGLE_SUBJECT_RULE,
    "",
    // A prompt that breaks this rule is REFUSED by the provider (CENSORED),
    // which is terminal — no key and no provider will accept it. Cheaper to
    // never write it than to catch it downstream. See safe-depiction.ts.
    SAFE_DEPICTION_RULE,
    "",
    // The other half of the refusal surface, and the one that actually killed
    // blocks: a named franchise or trademark. Placed BEFORE productBrandRule,
    // which permits packaging/logos for ordinary products and must not be read
    // as permission to name a character or a toy line. See safe-depiction.ts.
    NAMED_IP_RULE,
    "",
    ACTION_FIRST_RULE,
    "",
    INSTITUTION_NOT_PRODUCT_RULE,
    "",
    SCRIPT_MATCH_RULE,
    "",
    SUBJECT_IN_THE_WORLD_RULE,
    "",
    HANDS_RULE,
    "",
    EXAMINING_RULE,
    "",
    brollObjectRule(topic),
    "",
    contextVarietyRule(topic),
    "",
    SHOT_VARIETY_RULE,
    "",
    productBrandRule(topic),
    "",
    // Product/brand blocks are the one place text IS allowed on screen. On a
    // German video that packaging must not read as English, or the single
    // exception to the no-text rule becomes the thing that gives the
    // localisation away. Empty for English.
    ...onImageTextRule(locale),
    amateurLookRule(topic),
    "",
    "CONTINUITY (critical): when consecutive blocks describe one continuous",
    "scene, they MUST keep the SAME setting, lighting, subjects, and framing so",
    "they read as one continuous shot. Only change the visual world when the",
    "narration genuinely moves to a new scene.",
    "",
    "For ai_clip blocks also write an `animationPrompt` describing a REAL HUMAN",
    "ACTION (client requirement 2026-08-17). An ai_clip must show a PERSON DOING",
    "the thing the narration is talking about — pouring the milk, stirring the",
    "pot, planting the seedling, wiping the surface — NOT a still photo with a",
    "camera move over it. Write the specific action THIS block's narration",
    "describes, as one continuous everyday motion with a beginning and an end",
    "(e.g. 'she pours the milk from the bottle into the bowl of oats and tilts",
    "the bottle back upright').",
    "",
    "CRITICAL — the CAMERA MUST NOT MOVE. Only the PERSON moves. Never describe",
    "a push-in, zoom, pan, tilt, tracking shot, orbit, or camera shake: the",
    "camera is locked off on a tripod and the framing never changes. Camera",
    "movement is what made earlier footage look blurry and jumpy, which the",
    "client rejected — the motion must come from the SUBJECT, not the lens.",
    // SPEED, revised 2026-08-25 — same note as on ACTION_CLIP_RULE. The
    // 2026-08-22 "SLOWLY, calmly and deliberately" wording made Gemini write
    // barely-moving actions, and on a 4s clip behind a locked-off camera those
    // render as stills. Steady natural pace, and the action must COMPLETE.
    ...ANIMATION_SPEED_RULE_LINES,
    // HANDS, same date: "the hands(right and left) is different with each
    // other". Stated positively here because the negative prompt only guards
    // against wrong hands WITHIN a frame, not hands mutating between frames.
    "Where hands are visible, describe them staying consistent throughout: the",
    "same two hands, same shape and skin tone, five fingers each, never swapping",
    "or changing.",
    "Avoid dramatic/cinematic movement and scene changes",
    "mid-clip. If a block's narration genuinely has no human action in it, that",
    "block should be an `image`, not an `ai_clip`. avatar blocks need no prompts.",
    "",
    responseShape,
    "",
    ...tail,
  ].join("\n");
}

function buildPrompt(transcript: string, topic: VideoTopic = EMPTY_TOPIC): string {
  return composePlannerPrompt(topic, { mode: "text", transcript });
}

// Render the sentence list Gemini groups. Indices are GLOBAL (they index the
// whole transcript's sentence list, not the chunk), so a block's range needs
// no offsetting after the fact and a chunk boundary can't shift a range.
function buildSentencePrompt(
  sentences: TimedSentence[],
  from: number,
  to: number,
  topic: VideoTopic = EMPTY_TOPIC,
): string {
  const numbered = sentences
    .slice(from, to + 1)
    .map((s) => `[${s.index}] ${s.text}`)
    .join("\n");
  return composePlannerPrompt(topic, { mode: "sentences", numbered, from, to });
}

// Build the prompt for a SINGLE-segment image-prompt regeneration. Mirrors the
// scene-prompt rules of the full planner (CRITICAL picture-not-narration rule +
// the single-subject / no-text rule) but for ONE block: given this block's
// spoken `script` and the video's shared `basePrompt`, return only a fresh
// scene-specific imagePrompt. No segmentation, no JSON array.
function buildSingleSegmentPrompt(
  script: string,
  basePrompt: string,
  blockType: SyntheticBlockType,
  // Scenes the OTHER visuals of this SAME sentence already show. When this block
  // is one of several visuals covering one long sentence, we pass the prior
  // slots' prompts here so Gemini writes a GENUINELY DIFFERENT scene (different
  // subject / moment / detail) instead of a near-clone — the whole point of
  // having multiple visuals on a sentence is variety, not the same frame N times.
  avoidScenes: string[] = [],
  // Narration language. The `script` below is in it; the prompt we ask for is
  // not (see promptLanguageRule).
  language: LanguageCode = DEFAULT_LANGUAGE,
  // The prompt the image provider REFUSED on content policy, when this regen is
  // the recovery from a CENSORED generation. Printing it makes the retry a
  // targeted rewrite ("this exact text was refused") instead of another roll of
  // the same dice — without it the model has no way to know what to avoid and
  // routinely writes back a near-identical prompt that is refused again.
  refusedPrompt?: string,
  // The neighbouring narration lines. SCRIPT_MATCH_RULE tells the model that an
  // abstract line's visual should come from "whatever the surrounding sentences
  // are physically about" — but this single-block path used to see ONE line
  // only, so a connector like "That is not nostalgia." had no surroundings to
  // draw from and collapsed to the same modal base-world scene every time (the
  // duplicate-prompt failure measured on the Old Guns review, 2026-08-26).
  surroundingScript?: string,
  // This block is visual `index` of `total` covering ONE sentence. A long
  // sentence is split into N slots (splitByDuration), and each slot used to be
  // regenerated with nothing but "be different from these" — so every slot
  // independently picked another angle on the same idea and they converged.
  //
  // MEASURED on a live plan, one long sentence about manufacturing standards
  // held six slots, and the run around it read: cleaning a mechanism with a
  // brush, inspecting the bluing, oiling the stock, applying bluing solution,
  // inspecting the engraving, polishing the barrel. Each is "different" by the
  // dedupe metric and the sequence is still one person fiddling with a gun at a
  // bench for half a minute.
  //
  // Knowing the slot's place in the run lets the prompt ask for a PROGRESSION
  // — successive moments of one process — instead of N independent variations.
  sequence?: { index: number; total: number },
  // A reviewer's reason for rejecting the previous attempt at THIS block. The
  // match-verification pass judges every block against its line and feeds the
  // complaint back here, which is what makes the retry a correction rather than
  // another roll. Same shape as refusedPrompt below, for the same reason.
  mismatchReason?: string,
  // The model's OWN previous answer, when it came back as a duplicate of an
  // already-used scene. Appending that answer to avoidScenes was not enough:
  // measured on the list script, a block returned a listed scene VERBATIM twice
  // in a row (similarity 1.0 on both attempts) because one more line in a list
  // reads as one more constraint, not as "you already got this wrong". This
  // mirrors refusedPrompt below, which solved the identical problem for refused
  // prompts — a dedicated, emphatic block naming the exact failed text.
  clonedPrompt?: string,
): string {
  const wantsAnimation = blockType === "ai_clip";
  const hasAvoid = avoidScenes.filter((s) => s.trim()).length > 0;
  const refused = (refusedPrompt ?? "").trim();
  const locale = getLocale(language);
  return [
    ...promptLanguageRule(locale),
    // The regional look. Unlike the full planner this path has no derived
    // topic — the world comes from the stored basePrompt printed at the end —
    // but the REGION still has to be restated, or a regenerated block quietly
    // reverts to an American-looking scene beside its German neighbours.
    ...visualCultureRule(locale),
    "You are a video director writing the visual for ONE block of an",
    "AI-generated narrated video. Below is the block's spoken narration",
    "(`script`) and the video's shared visual world (`basePrompt`).",
    "",
    "Write a concrete `imagePrompt`: ONLY the scene-specific detail for THIS",
    "block — the action, the specific subject and composition of this moment.",
    "Do NOT repeat the basePrompt (it is prepended automatically). Do NOT include",
    "camera or film-grain styling (appended separately).",
    "",
    "CRITICAL — the imagePrompt is a PICTURE DESCRIPTION, never the narration.",
    "NEVER copy, paraphrase, or echo the `script` into the imagePrompt. The script",
    "is what is SPOKEN; the imagePrompt is what is SHOWN. When the line is",
    "conversational, abstract, or filler, INVENT an on-topic visual that fits the",
    "video's world — do NOT fall back to the spoken words.",
    ...(hasAvoid
      ? [
          "",
          "SAME SUBJECT, DIFFERENT SHOT (critical — read this before anything else):",
          "some scenes below have already been used in this video. You must write a",
          "DIFFERENT PICTURE. You must NOT write a different SUBJECT.",
          "",
          "If this block's line is about the same thing an earlier line was about,",
          "that thing STAYS in the frame. Change the shot instead: a different",
          "moment in the same process, a different stage, a different part or",
          "detail, a different scale, the same thing in a different place, someone",
          "using it, the result of using it.",
          "",
          "FORBIDDEN, and this is the failure the client rejects: dropping the",
          "line's own subject in order to avoid repeating. Showing a different",
          "object that merely belongs to the same world — the receipt instead of",
          "the machine, the tool instead of the thing it was used on, someone's",
          "hands instead of the person the line is about — is WRONG even when the",
          "picture is beautiful and even when every scene below is avoided. Two",
          "similar shots of the correct subject beat one shot of the wrong one.",
          "",
          "If you genuinely cannot find another angle on the subject, keep the",
          "subject and change everything else — a different moment, place, scale",
          "or stage. What you must NEVER do is return one of the scenes below",
          "word-for-word or with trivial rewording: an answer that reads like a",
          "listed scene is a wasted generation, because the video already shows",
          "that exact frame.",
          "ALREADY-USED scene(s) — frame this block's subject differently from these:",
          ...avoidScenes.filter((s) => s.trim()).map((s, i) => `  ${i + 1}. ${s.trim()}`),
        ]
      : []),
    ...(sequence && sequence.total > 1
      ? [
          "",
          `ONE SENTENCE, ${sequence.total} PICTURES — this is picture ${sequence.index} of ${sequence.total}.`,
          "The line below is on screen long enough to need several visuals, and",
          "they play BACK TO BACK. So they must read as a SEQUENCE, not as",
          `${sequence.total} separate attempts at the same idea. Move the story`,
          "forward: an earlier and a later moment of the same process, a step and",
          "its result, the wide view and then the thing it was about, one place",
          "and then the next place. Picture " + sequence.index + " should look like",
          "what happens AFTER the scenes listed above, not another angle on them.",
          "If the earlier pictures were all one person at one surface, this one",
          "must leave that surface — a different place, a different scale, or the",
          "consequence of what they were doing.",
        ]
      : []),
    ...((mismatchReason ?? "").trim()
      ? [
          "",
          "A REVIEWER REJECTED THE PREVIOUS PICTURE FOR THIS LINE (critical).",
          "Their reason, verbatim:",
          `  "${(mismatchReason ?? "").trim()}"`,
          "That reason is the thing to fix. Do not simply write another scene and",
          "hope — read the line below, work out what it is actually about, and",
          "make THAT the subject of the frame. If the reviewer says the picture",
          "showed the wrong thing, the new picture shows the right thing. If they",
          "say the subject was hidden, covered or wrapped, it is now plainly",
          "visible. If they say the shot was generic where the line was specific,",
          "name the specific thing the line names.",
        ]
      : []),
    ...((clonedPrompt ?? "").trim()
      ? [
          "",
          "YOUR PREVIOUS ANSWER WAS A DUPLICATE (critical): you were already asked",
          "for this block and you returned the scene below, which is one of the",
          "already-used scenes above, or a trivial rewording of one. The video",
          "would show the SAME PICTURE twice. Do not send it again, and do not send",
          "a reworded version of it.",
          "Start from the block's own line instead: name the concrete things IT",
          "mentions — the specific parts, materials, numbers, places or people in",
          "these exact words — and build the picture on whichever of them the",
          "earlier scenes did NOT show. If the line describes a CHANGE, a contrast,",
          "or a worse/cheaper/later version of something already pictured, then the",
          "picture is that DIFFERENCE, not another view of the original.",
          "DUPLICATE answer (do NOT reproduce or reword it):",
          `  ${(clonedPrompt ?? "").trim()}`,
        ]
      : []),
    "",
    SINGLE_SUBJECT_RULE,
    "",
    // A prompt that breaks this rule is REFUSED by the provider (CENSORED),
    // which is terminal — no key and no provider will accept it. Cheaper to
    // never write it than to catch it downstream. See safe-depiction.ts.
    SAFE_DEPICTION_RULE,
    "",
    // Same rule as the full planner: a single-block regen is exactly where a
    // refused IP prompt lands, so it needs this MORE than the batch path does.
    NAMED_IP_RULE,
    ...(refused
      ? [
          "",
          "REFUSED PROMPT (critical): the image provider REJECTED the prompt below",
          "on CONTENT POLICY, so the block could not be generated at all. Write a",
          "prompt that tells the SAME story beat but shows NOTHING the filter can",
          "refuse. There are only two things it ever refuses, so check BOTH:",
          "  1. HARM — an act of force, or a subject in distress. Remove the act,",
          "     remove the distress, and show the AFTERMATH or a neutral object",
          "     standing in for it (see the SAFE DEPICTION rule above).",
          "  2. A BRAND, FRANCHISE, or CHARACTER — either NAMED, or described",
          "     closely enough to recognise (its costume, helmet, colours, face),",
          "     or a logo / wordmark / packaging text / card face asked to be",
          "     reproduced. Strip the name AND the likeness, and shoot the",
          "     ARTEFACT instead: size, material, wear, the hands holding it, the",
          "     packaging, the shelf (see the NO NAMED BRANDS OR CHARACTERS rule",
          "     above). If the refused prompt names or describes any character,",
          "     property, or product, assume THIS is why it was refused and fix it",
          "     first — it is by far the more common of the two.",
          "Do NOT reword the refused prompt — picture a genuinely different, calm,",
          "nameless moment of the same idea.",
          "REFUSED prompt (do NOT reproduce it):",
          `  ${refused}`,
        ]
      : []),
    "",
    // Regeneration anchors the niche via the stored basePrompt (printed below),
    // so the rule text here stays niche-neutral (EMPTY_TOPIC) — no need to
    // re-derive the topic for a single-block regen.
    ACTION_FIRST_RULE,
    "",
    INSTITUTION_NOT_PRODUCT_RULE,
    "",
    SCRIPT_MATCH_RULE,
    "",
    SUBJECT_IN_THE_WORLD_RULE,
    "",
    HANDS_RULE,
    "",
    EXAMINING_RULE,
    "",
    brollObjectRule(EMPTY_TOPIC),
    "",
    contextVarietyRule(EMPTY_TOPIC),
    "",
    "Also pick a `shotType` (camera framing) from: " + SHOT_TYPES + ". Choose one",
    "that fits this line's subject; it is camera distance/angle ONLY, no subject or",
    "film-look words.",
    "",
    productBrandRule(EMPTY_TOPIC),
    "",
    ...onImageTextRule(locale),
    amateurLookRule(EMPTY_TOPIC),
    "",
    wantsAnimation
      // Kept in step with the full planner prompt above (client 2026-08-22): the
      // action is performed SLOWLY and the hands stay consistent. A regenerated
      // block goes straight to the clip lane, so wording that drifts from the
      // planner's shows up as a handful of fast, smeared clips scattered through
      // an otherwise slow video -- worse than either setting applied uniformly.
      ? 'Respond ONLY with JSON: {"imagePrompt","shotType","animationPrompt"}  (animationPrompt = the motion in THIS block, matching THIS block\'s narration. If the scene has a person in it, that is the action the person performs. If the scene has NO person in it, the motion is what the scene ITSELF does (the object moving, being poured, steaming, swaying, turning, light shifting) and NO hands, fingers, arms or any part of a body may enter the frame at any point — do not write "a hand reaches in", ever, for a scene with no person in it. SOMETHING MUST TRAVEL: with a locked-off camera and about four seconds, the only thing that tells a viewer this is video and not a photograph is a subject that visibly CROSSES THE FRAME. Describe an action with real distance in it (someone walking in or out, a hand carrying something across, a lid coming off, a drawer pulled open, liquid pouring, a door swinging, an object lifted clear and set down elsewhere) and let it complete inside the clip. THE TEST: if the first and last frame could be mistaken for the same photograph, the clip has failed — a fingertip turning a dial or a slight adjustment fails it. Pace is ORDINARY and natural; never rushed or jerky, never a slow-motion effect, and do NOT call the action slow, gentle, careful or subtle, because those words shrink it until nothing happens. Where hands are visible they stay consistent throughout: the same two hands, same shape and skin tone, five fingers each, never swapping or changing. The CAMERA IS LOCKED OFF and NEVER MOVES — no push-in, no zoom, no pan, no tilt, no tracking, no shake; only the SUBJECT moves. NEVER a product-turntable shot: the object must not spin, rotate or revolve on its own and the camera must not circle it — a thing rotating in space is stock-video filler. No cinematic movement.).'
      : 'Respond ONLY with JSON: {"imagePrompt","shotType"}',
    "",
    `basePrompt: ${basePrompt.trim() || "(none)"}`,
    "",
    "script:",
    script.trim(),
    ...((surroundingScript ?? "").trim()
      ? [
          "",
          "surrounding narration (CONTEXT ONLY — these lines are spoken before/after",
          "this block and get their own visuals; do not depict them directly. But",
          "when THIS block's script is abstract, a connector, or pure commentary,",
          "invent the visual from what THESE lines are physically about — a new",
          "moment of that same story — never from a generic default of the world):",
          (surroundingScript ?? "").trim(),
        ]
      : []),
  ].join("\n");
}

const SingleSegmentSchema = z.object({
  imagePrompt: z.string().min(1),
  shotType: optString(),
  animationPrompt: optString(),
});

// Animation answers that describe NO motion. Stored verbatim these produce a
// frozen clip, so they are treated as if the field were empty -- see
// resolveAnimationPrompt for what then covers the block.
// Only a word that ASSERTS ABSENCE counts. An earlier version also keyed on a
// leading "motion"/"movement", which matched ordinary descriptions ("motion of
// the water settles") and threw them away.
const NO_MOTION_ANSWER_RE = /^(no|none|n\/a|null|nothing|static|still|frozen|motionless|zero)\b/i;

// Motion answers that move the CAMERA, or spin the subject on a turntable.
//
// Client 2026-08-26: "not just guns that rotate like this". Caught in our own
// test output the same day: for a line with no action in it, the model answered
// "the camera slowly rotates around the Luger pistol" -- both a camera move
// (banned: the camera is locked off) and the product-turntable cliche.
//
// A stored answer beats every fallback, so an unguarded one of these renders as
// the shot the client rejects on sight. Treated as absent, exactly like a
// no-motion answer: the scene-aware default then covers the block.
const CAMERA_MOVE_RE =
  /\bcamera\b[^.]{0,40}?\b(?:rotat|revolv|orbit|circl|spin|pan|tilt|zoom|track|dolly|mov|drift|push|pull|swing|glide|sweep)\w*|\b(?:slow|slowly)?\s*(?:push[- ]in|pull[- ]back|dolly\s+shot|crane\s+shot|orbit(?:ing)?\s+shot|tracking\s+shot|turntable)\b|\b(?:rotat|circl|revolv|orbit)\w*\s+(?:slowly\s+)?around\b/i;

// The SUBJECT spinning in place with nothing else happening -- the product
// turntable, arrived at from the other direction.
const TURNTABLE_RE = /\b(rotat\w*|spin\w*|revolv\w*|turn\w*)\s+(?:slowly\s+)?(?:on|in place|on the spot|on a turntable)\b/i;

export function describesCameraMove(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return CAMERA_MOVE_RE.test(t) || TURNTABLE_RE.test(t);
}

export function isNoMotionAnswer(text: string | null | undefined): boolean {
  const t = (text ?? "").trim().replace(/^["']|["'.]+$/g, "");
  if (!t) return true;
  if (!NO_MOTION_ANSWER_RE.test(t)) return false;
  // A real description that merely STARTS with one of those words ("still water
  // in the trough ripples as the tap drips") is a sentence. An answer meaning
  // "there is no motion here" is two or three words. Bias to keeping the text:
  // a false positive only falls back to the scene-aware default, while a false
  // negative stores a frozen clip.
  return t.split(/\s+/).length <= 5;
}

export interface RegeneratedPrompt {
  imagePrompt: string;        // composed WITH the base prompt in front
  animationPrompt: string | null;
}

/**
 * Regenerate the AI image prompt for a SINGLE segment (review screen:
 * "Regenerate prompt"). Re-runs Gemini for just this block's script using the
 * same single-subject / no-text rules as the full planner, and returns the
 * composed image_prompt (base prompt prepended, exactly like buildSyntheticTimeline
 * persists it). Does NOT regenerate the image — the caller persists the new
 * prompt and the user clicks Regenerate to rebuild the asset.
 */
export async function regenerateSegmentPrompt(input: {
  projectId: string;
  jobId?: string;
  script: string;
  basePrompt: string;
  blockType: SyntheticBlockType;
  // Optional scenes that OTHER visuals of this same sentence already show, so the
  // regenerated prompt is a genuinely different picture (see buildSingleSegmentPrompt).
  avoidScenes?: string[];
  // Narration language (projects.language). Omitted = English, so callers that
  // predate multi-language support are unaffected.
  language?: LanguageCode;
  // Set by the CENSORED-recovery path in imageGenProcessor: the exact prompt the
  // provider refused. Makes this a targeted safe rewrite instead of a re-roll.
  refusedPrompt?: string;
  // Neighbouring narration lines (context only). Lets an abstract connector
  // line draw its visual from what the surrounding story is physically about
  // instead of collapsing to the base world's modal scene — see
  // buildSingleSegmentPrompt.
  surroundingScript?: string;
  // This visual's place in a run of visuals covering ONE sentence, so the run
  // reads as a sequence rather than N variations. See buildSingleSegmentPrompt.
  sequence?: { index: number; total: number };
  // Why a reviewer judged the previous prompt as not belonging to this line.
  // Set by the match-verification pass so the rewrite is aimed at the actual
  // complaint instead of being another roll of the same dice.
  mismatchReason?: string;
}): Promise<RegeneratedPrompt> {
  const { projectId, jobId, script, basePrompt, blockType, avoidScenes, language, refusedPrompt, surroundingScript, sequence, mismatchReason } = input;
  if (blockType === "avatar") {
    throw new Error("regenerateSegmentPrompt: avatar blocks have no image prompt");
  }
  if (!script.trim()) throw new Error("regenerateSegmentPrompt: empty script");

  // Parse INSIDE the model callback so a truncated / MAX_TOKENS response is
  // thrown as a retryable GEMINI_TRUNCATED error — that lets withGeminiModelFallback
  // retry and fail over to the lite model (which does NOT overrun the budget),
  // instead of a hard "returned non-JSON" throw that never retries. This was the
  // cause of the per-segment Regenerate-prompt button failing on the current
  // gemini-flash-latest while the same call succeeded on the fallback model.
  const attempt = (avoid: string[], cloned?: string) => withGeminiModelFallback(
    "regenerateSegmentPrompt",
    async (model) => {
      const res = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: buildSingleSegmentPrompt(script, basePrompt, blockType, avoid, language ?? DEFAULT_LANGUAGE, refusedPrompt, surroundingScript, sequence, mismatchReason, cloned) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.4,
          // One block's prompt is tiny (imagePrompt + optional shotType +
          // animationPrompt), but leave clear headroom so a verbose scene
          // description can't truncate mid-string.
          maxOutputTokens: 2048,
          // The current Gemini model can spend its whole output budget on
          // internal reasoning before emitting JSON (see buildSyntheticTimeline);
          // we don't need chain-of-thought to write one scene prompt.
          thinkingConfig: { thinkingBudget: 0 },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      const txt = res.response.text();
      const finishReason = res.response.candidates?.[0]?.finishReason;
      let parsed: unknown;
      try {
        parsed = JSON.parse(txt);
      } catch {
        // Retryable so the fallback model gets a turn; tag carries the reason.
        throw new Error(
          `GEMINI_TRUNCATED regenerateSegmentPrompt non-JSON (finishReason=${finishReason}, chars=${txt.length}): ${txt.slice(0, 120)}`,
        );
      }
      const parsedSafe = SingleSegmentSchema.safeParse(parsed);
      if (!parsedSafe.success) {
        // A complete-but-wrong-shape response is a real schema error, not an
        // outage — do NOT tag it retryable.
        throw new Error(`regenerateSegmentPrompt: schema: ${JSON.stringify(parsedSafe.error.flatten()).slice(0, 200)}`);
      }
      return parsedSafe.data;
    },
    // SHORT primary ladder: during a broad primary 503 spike (the cause of the
    // 2026-07 planner slowdown) we don't want each of the ~74 regen calls to
    // burn ~20s exhausting the dead primary. 2 quick attempts, then fail over to
    // the healthy fallback which gets the fuller budget.
    { attempts: 2, baseMs: 800 },
    { attempts: 4, baseMs: 1500 },
  );

  const avoidList = (avoidScenes ?? []).map((s) => s.trim()).filter(Boolean);
  let { result: safe, model: usedModel } = await attempt(avoidList);

  // TRUST BUT VERIFY (2026-08-26). Every avoid-list caller in this file used to
  // accept the regenerated prompt unchecked, and the model DOES return a listed
  // scene verbatim — measured on the Old Guns review: three of 25 lines came
  // back word-for-word identical to a scene sitting in their own avoid list
  // (abstract connector lines, where the base world's modal scene is the
  // strongest completion). One targeted retry with the clone itself appended to
  // the avoid list; keep whichever answer is less similar to the avoided
  // scenes. Same similarity metric and threshold as the dedupe pass that
  // flagged the block in the first place, so an answer accepted here won't
  // simply be re-flagged on the next pass.
  if (avoidList.length > 0) {
    const stripSetting = (p: string) => p.replace(/\. Setting:[\s\S]*$/i, "");
    const threshold = getEnv().SYNTHETIC_SCENE_DEDUPE_SIMILARITY;
    const similarityToAvoided = (p: string) =>
      Math.max(0, ...avoidList.map((a) => sceneSimilarity(sceneWords(stripSetting(p)), sceneWords(stripSetting(a)))));
    const firstSim = similarityToAvoided(safe.imagePrompt);
    if (firstSim >= threshold) {
      const retry = await attempt([...avoidList, safe.imagePrompt.trim()], safe.imagePrompt.trim());
      const retrySim = similarityToAvoided(retry.result.imagePrompt);
      if (retrySim < firstSim) {
        safe = retry.result;
        usedModel = retry.model;
      }
      await logJob({ projectId, jobId }, "synthetic.prompt_regen.clone_retry", {
        firstSimilarity: Number(firstSim.toFixed(2)),
        retrySimilarity: Number(retrySim.toFixed(2)),
        kept: retrySim < firstSim ? "retry" : "first",
        stillClone: Math.min(firstSim, retrySim) >= threshold,
      });
    }
  }

  if (usedModel !== getEnv().GEMINI_MODEL) {
    await logJob({ projectId, jobId }, "synthetic.prompt_regen.model_fallback", { model: usedModel });
  }

  return {
    // Compose the base in front exactly like persist does, so the stored prompt
    // carries the recurring world (composePrompt is the same helper).
    imagePrompt:
      composePrompt(basePrompt, safe.imagePrompt.trim(), safe.shotType?.trim() || null) ??
      safe.imagePrompt.trim(),
    animationPrompt:
      blockType === "ai_clip" &&
      !isNoMotionAnswer(safe.animationPrompt) &&
      !describesCameraMove(safe.animationPrompt)
        ? (safe.animationPrompt?.trim() || null)
        : null,
  };
}

// ---------------------------------------------------------------------------
// MOTION FOR BLOCKS THAT WERE NEVER PLANNED AS CLIPS
// (client 2026-08-25 via Joey: "im not happy with the logic behind the clips /
// they are very random and do not match at all / its very very bad actually").
// ---------------------------------------------------------------------------
// Gemini writes an animationPrompt only for the blocks IT chose as ai_clip. But
// most clips in a shipped video were not chosen by Gemini at all -- they were
// PROMOTED by the two budget passes, which pick blocks by TIMING and SECONDS:
//
//   - clip_heavy_intro promotes every 'image' block starting before
//     SYNTHETIC_CLIP_HEAVY_SECONDS (900s);
//   - assignClipDurationQuota promotes stills until each phase's seconds budget
//     is full -- 80% of the opening 4 minutes, per the client's 2026-08-18 ask.
//
// Neither writes an animationPrompt (both left it null, with a comment pointing
// at "the worker's default gentle pan" -- wording that predates the action-clip
// direction by two months). So the worker fell back to a GENERIC prompt chosen
// by a regex over the image prompt: either "the person continues the everyday
// action they are already doing" or ambient leaves-and-dust. Both are written
// blind to what the block is actually SAYING, which is exactly the report: the
// footage moves, but the movement has no relationship to the narration.
//
// The fix is not to promote fewer blocks -- the 80% share is the client's own
// number -- but to write real motion for the ones we promote. One batched call
// covers a dozen blocks; a failure is non-fatal and leaves those blocks on the
// worker's fallback, exactly as before this pass existed.
const AnimationBatchSchema = z.object({
  animations: z.array(z.object({ i: z.number().int(), animationPrompt: z.string().min(1) })),
});

// Blocks per Gemini call. Small enough that one bad response costs a handful of
// blocks rather than the video, large enough that a 300-block plan is ~25 calls.
const ANIMATION_BATCH_SIZE = 12;

function buildAnimationBatchPrompt(
  basePrompt: string,
  blocks: Array<{ i: number; script: string; imagePrompt: string }>,
): string {
  return [
    "You are writing the MOTION for shots in a documentary-style video. Each shot",
    "below already exists as a still photograph, and each one is spoken over by a",
    "specific line of narration. For every shot, write one animationPrompt: what",
    "MOVES in that frame while those words are heard.",
    "",
    "THE RULE THAT MATTERS MOST: the movement must be about what THIS shot's own",
    "narration is saying. A shot whose motion has nothing to do with its own line",
    "is worthless to us -- it is the single thing the client rejects.",
    "",
    "LOOK AT WHAT THE STILL ACTUALLY SHOWS before choosing:",
    "  - If the scene shows a person, hands, or any part of a body, write the REAL",
    "    HUMAN ACTION that person performs -- the thing the narration describes",
    "    them doing (pouring, stirring, lifting, digging, wiping, pointing).",
    "  - If the scene shows NO person, write the natural movement the scene ITSELF",
    "    contains and that the narration is about: an animal moving, water running,",
    "    a web swaying, leaves stirring, steam rising, a machine turning, light",
    "    shifting. In that case NO PEOPLE, hands, fingers or arms may enter the",
    "    frame at any point -- never invent a person who is not in the still.",
    "",
    ...ANIMATION_SPEED_RULE_LINES,
    "",
    "THE CAMERA IS LOCKED OFF ON A TRIPOD and never moves: no push-in, no zoom, no",
    "pan, no tilt, no tracking, no orbit, no shake. Only the subject moves and the",
    "framing never changes. Do not describe camera moves, cuts, scene changes or",
    "on-screen text.",
    "",
    "NEVER a product-turntable shot: the object must not spin, rotate, revolve or",
    "orbit on its own, and the frame must not circle around it. A thing rotating in",
    "space is stock-video filler and the client rejects it on sight — if the only",
    "motion you can think of for a scene is the object turning, you have chosen the",
    "wrong scene, and the block should show whatever its line describes happening.",
    "",
    "Where hands are visible, say they stay consistent throughout: the same two",
    "hands, same shape and skin tone, five fingers each, never swapping or changing.",
    "",
    "Write 1-2 sentences per shot, present tense, describing only the movement. Do",
    "NOT re-describe the whole scene -- the still already exists.",
    "",
    basePrompt.trim() ? `The video's recurring world: ${basePrompt.trim()}` : "",
    "",
    "SHOTS:",
    ...blocks.map((b) =>
      [
        `--- shot ${b.i}`,
        `narration: ${b.script.trim().slice(0, 600)}`,
        `still shows: ${b.imagePrompt.trim().slice(0, 600)}`,
      ].join("\n"),
    ),
    "",
    'Respond ONLY with JSON: {"animations":[{"i":<the shot number>,"animationPrompt":"..."}]}',
    "Return one entry for EVERY shot listed above, keyed by its shot number.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Write a per-block animationPrompt for clips that have none, from each block's
 * OWN narration and its OWN scene. Returns a map of block index -> prompt;
 * blocks the model omits are simply absent, and the caller leaves those on the
 * worker's fallback rather than failing the plan over them.
 */
export async function generateAnimationPrompts(input: {
  projectId: string;
  jobId?: string;
  basePrompt?: string;
  blocks: Array<{ i: number; script: string; imagePrompt: string }>;
}): Promise<Map<number, string>> {
  const { projectId, jobId, basePrompt = "", blocks } = input;
  const out = new Map<number, string>();
  if (blocks.length === 0) return out;

  const batches: Array<Array<{ i: number; script: string; imagePrompt: string }>> = [];
  for (let i = 0; i < blocks.length; i += ANIMATION_BATCH_SIZE) {
    batches.push(blocks.slice(i, i + ANIMATION_BATCH_SIZE));
  }

  // Same concurrency as the plan's other regeneration passes, for the same
  // reason: enough to keep a long video's fill under a minute, low enough not to
  // trip Gemini's rate limit alongside them.
  const limit = makeLimit(5);
  let failedBatches = 0;
  await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        try {
          const { result } = await withGeminiModelFallback(
            "generateAnimationPrompts",
            async (model) => {
              const res = await model.generateContent({
                contents: [
                  { role: "user", parts: [{ text: buildAnimationBatchPrompt(basePrompt, batch) }] },
                ],
                generationConfig: {
                  responseMimeType: "application/json",
                  // Slightly warm: a whole video of promoted blocks written at
                  // temperature 0 converges on the same three verbs.
                  temperature: 0.6,
                  // ~12 short motion descriptions, with headroom so a verbose
                  // batch cannot truncate mid-string.
                  maxOutputTokens: 4096,
                  // No chain-of-thought needed to describe movement, and the
                  // current model will otherwise spend the whole budget on it
                  // before emitting any JSON (see buildSyntheticTimeline).
                  thinkingConfig: { thinkingBudget: 0 },
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any,
              });
              const txt = res.response.text();
              const finishReason = res.response.candidates?.[0]?.finishReason;
              let parsed: unknown;
              try {
                parsed = JSON.parse(txt);
              } catch {
                // Tagged retryable so the fallback model gets a turn -- same
                // handling as regenerateSegmentPrompt.
                throw new Error(
                  `GEMINI_TRUNCATED generateAnimationPrompts non-JSON (finishReason=${finishReason}, chars=${txt.length})`,
                );
              }
              const safe = AnimationBatchSchema.safeParse(parsed);
              if (!safe.success) {
                throw new Error(
                  `generateAnimationPrompts: schema: ${JSON.stringify(safe.error.flatten()).slice(0, 200)}`,
                );
              }
              return safe.data;
            },
            { attempts: 2, baseMs: 800 },
            { attempts: 4, baseMs: 1500 },
          );
          // Only accept indices we actually asked about. A model that invents a
          // shot number would otherwise write motion onto an unrelated block --
          // the very bug this pass exists to fix.
          const asked = new Set(batch.map((b) => b.i));
          for (const a of result.animations) {
            const prompt = a.animationPrompt.trim();
            // isNoMotionAnswer: the model answers "no movement" / "still image"
            // on scenes it judges static, and a stored answer beats every
            // fallback -- so drop it and let the scene-aware default cover the
            // block instead of storing a frozen clip.
            // describesCameraMove: the camera is locked off, and a subject
            // spinning on the spot is the turntable shot the client rejects.
            if (prompt && asked.has(a.i) && !isNoMotionAnswer(prompt) && !describesCameraMove(prompt)) {
              out.set(a.i, prompt);
            }
          }
        } catch (e) {
          failedBatches++;
          await logJob({ projectId, jobId }, "synthetic.plan.animation_prompts.batch_failed", {
            blocks: batch.map((b) => b.i),
            err: (e as Error).message?.slice(0, 200),
          });
        }
      }),
    ),
  );
  if (failedBatches > 0) {
    await logJob({ projectId, jobId }, "synthetic.plan.animation_prompts.partial", {
      batches: batches.length,
      failedBatches,
      note: "those blocks keep the worker's generic fallback motion",
    });
  }
  return out;
}

// Stamp each Gemini segment with its real spoken window from the Deepgram word
// timings. This DELEGATES to the sourced engine's battle-tested aligner
// (alignSentencesToWords) rather than re-implementing alignment here.
//
// The previous hand-rolled aligner matched only a segment's FIRST word against
// the word stream and assumed the segment occupied exactly its (paraphrased)
// token count of contiguous words. Both assumptions break on real transcripts:
// a common first word ("It", "So", "How") matched a far-later occurrence,
// jumping the cursor to the end of the audio — which (a) produced absurd
// durations for the segment that mis-matched (e.g. 50s+) and (b) stranded every
// following segment with no remaining words to match, collapsing them all to
// the 0.5s floor. alignSentencesToWords avoids this with 3-token head+tail
// brackets, number canonicalization, bounded forward search, and a desync
// sanity check that recovers instead of cascading.
function alignSegments(
  segs: Array<z.infer<typeof GeminiSegmentSchema>>,
  words: WordTiming[] | null,
  totalDuration: number,
): PlannedSegment[] {
  const out: PlannedSegment[] = [];

  if (!words || words.length === 0) {
    // No timings: distribute by word-count proportion of total duration.
    const counts = segs.map((s) => Math.max(1, s.script.trim().split(/\s+/).length));
    const totalWords = counts.reduce((a, b) => a + b, 0) || 1;
    let cursor = 0;
    segs.forEach((s, i) => {
      const dur = (counts[i] / totalWords) * totalDuration;
      out.push(mk(s, i, cursor, cursor + dur));
      cursor += dur;
    });
    return out;
  }

  // Adapt each segment to the Sentence shape the aligner expects (it only reads
  // `.text`; the other fields are inert here). The aligner returns a window per
  // segment, in order, never dropping one.
  const pseudoSentences: Sentence[] = segs.map((s) => ({
    text: s.script.trim(),
    paragraph_index: 0,
    sentence_index_in_paragraph: 0,
    is_section_first_sentence: false,
    char_offset: 0,
  }));
  const aligned = alignSentencesToWords(pseudoSentences, words);
  segs.forEach((s, i) => {
    const a = aligned[i];
    out.push(mk(s, i, a.vo_start, Math.max(a.vo_end, a.vo_start + 0.5)));
  });

  // Make the timeline continuous: snap each block's start to the previous
  // block's end and the last block's end to the audio duration.
  for (let i = 1; i < out.length; i++) {
    out[i].startTime = out[i - 1].endTime;
    // Keep end >= start after the start snap so duration never goes negative
    // (a synthesized/short window can land entirely before the prior end).
    if (out[i].endTime < out[i].startTime) out[i].endTime = out[i].startTime;
  }
  if (out.length > 0 && totalDuration > 0) out[out.length - 1].endTime = totalDuration;
  for (const seg of out) seg.duration = Math.max(0.5, seg.endTime - seg.startTime);
  return out;
}

// Prepend the video's shared style bible to a block's scene-specific prompt so
// the stored image_prompt carries the recurring world (subjects, setting, mood)
// alongside this moment's detail. Keeps adjacent same-scene blocks visually
// continuous. STYLE_PROMPT (the camera/grain look) is still appended separately
// at generation time. Returns the block prompt unchanged when there's no base,
// and the base alone when the block has no specific prompt.
// Subject-first ordering (client variety fix): image models weight the FRONT of
// the prompt most, so leading every prompt with the long shared basePrompt made
// the model lock onto the same recurring world ("hands-in-the-dirt garden") and
// IGNORE the short per-line subject — every still came out looking the same. We
// now lead with the block's SHOT TYPE + scene-specific prompt (the thing that
// actually varies) and append the basePrompt as a trailing setting/mood clause,
// so the subject and framing dominate and the world is context, not the lede.
// A DRIFTED basePrompt POISONS THE WHOLE VIDEO (client 2026-08-25, Loom:
// "the footage is so repetitive ... constantly someone holding a computer on a
// mountain. It doesn't make sense").
//
// composePrompt below appends the base to EVERY visual block as
// "`. Setting: <base>.`". With ~200 blocks in a 20-minute video, one bad
// sentence is rendered two hundred times. If the base says "a person holding a
// laptop on a mountainside", every shot in the video contains a person holding a
// laptop on a mountainside -- which is both the repetition the client reports
// and the nonsense he reports, from a single cause.
//
// The planner prompt already TELLS Gemini what a base may contain (setting, era,
// mood only -- no fixed framing, no named subject). Nothing ENFORCED it: the
// answer was taken verbatim with `if (i === 0) basePrompt = bp`. An instruction
// without a check is a suggestion, and on a long enough run the model declines
// it. This is the check.
//
// STRIPS rather than rejects: a base is a comma-separated list of clauses, and
// the offending one is usually a single clause among several good ones ("a rural
// kitchen, warm afternoon light, a woman kneading dough" -> drop the last).
// Dropping beats regenerating: it needs no extra model call on the plan's
// critical path, and it cannot fail open.
//
// An EMPTY result is a perfectly safe outcome -- composePrompt returns the
// block's own prompt when the base is empty, so each shot simply stands on its
// own scene description. That is strictly better than a poisoned world.

// Framing/composition words. A base must never fix the camera: that is each
// block's shotType, and baking one in makes every shot the same picture.
const BASE_FRAMING_RE =
  /\b(close[- ]?up|closeup|wide shot|medium shot|macro|portrait|overhead|bird'?s[- ]eye|low[- ]angle|high[- ]angle|over[- ]the[- ]shoulder|shot of|framed?|composition)\b/i;

// A named human subject, usually with an action attached. This is the clause
// that produced "someone holding a computer": a person doing a specific thing,
// pinned into every frame of the video.
const BASE_SUBJECT_RE =
  /\b(a|an|the|one|someone|somebody)\s+(?:\w+\s+){0,2}(man|woman|person|people|guy|girl|boy|child|kid|adult|figure|worker|farmer|scientist|researcher|presenter|host)\b/i;

// Actions pin a subject into a fixed pose across the whole video.
const BASE_ACTION_RE =
  /\b(holding|carrying|standing|sitting|kneeling|walking|wearing|using|operating|pointing|looking at|working on)\b/i;

function clauseIsPoison(clause: string): boolean {
  const c = clause.trim();
  if (!c) return true;
  return BASE_FRAMING_RE.test(c) || BASE_SUBJECT_RE.test(c) || BASE_ACTION_RE.test(c);
}

export interface BasePromptCheck {
  cleaned: string;
  dropped: string[];
}

/**
 * Strip clauses that must not be repeated across every block of a video.
 *
 * Returns the surviving clauses joined back together, plus what was removed so
 * the plan log can show it. A base that is entirely poison cleans to "" -- see
 * the note above for why that is safe.
 */
export function sanitizeBasePrompt(basePrompt: string | null | undefined): BasePromptCheck {
  const raw = (basePrompt ?? "").trim();
  if (!raw) return { cleaned: "", dropped: [] };

  // Split on commas and semicolons only. Sentences are NOT split on "." because
  // a base is written as one sentence and periods appear inside abbreviations.
  const clauses = raw.split(/[,;]+/).map((c) => c.trim()).filter(Boolean);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const c of clauses) {
    if (clauseIsPoison(c)) dropped.push(c);
    else kept.push(c);
  }

  // Nothing splittable (a single clause) that is itself poison -> empty.
  return { cleaned: kept.join(", ").replace(/[.,\s]+$/, ""), dropped };
}

/** sanitizeBasePrompt + a log line naming what was removed and why. */
async function applyBasePromptGuard(
  raw: string,
  ids: { projectId: string; jobId?: string },
): Promise<string> {
  const { cleaned, dropped } = sanitizeBasePrompt(raw);
  if (dropped.length > 0) {
    await logJob(ids, "synthetic.plan.base_prompt_sanitized", {
      original: raw.slice(0, 300),
      cleaned: cleaned.slice(0, 300),
      dropped,
      // Every block of the video would have carried these clauses.
      note: "clauses fixing a subject/action/framing were removed from the recurring world",
    });
  }
  return cleaned;
}

// Does this block already establish WHERE it happens?
//
// The base prompt is appended to every block as ". Setting: <base>.", which is
// right when the block only describes a subject and wrong when the block has
// already chosen a place. Measured 2026-08-26 on a live plan:
//
//   block: "A person at home, holding a package... kitchen counter in background"
//   base : "Setting: A brightly lit, clean supermarket meat aisle and a sterile
//           food laboratory..."
//
// Two contradictory locations in one prompt. The image model cannot satisfy
// both, and every one of that project's 428 blocks was pinned to those two rooms
// regardless of what its own line was about -- which is the "everything looks
// the same" complaint, arriving through the world rather than the subject.
//
// Deliberately conservative: it looks for an explicit place, not any noun, so a
// block that merely names an object still gets the world appended (the base's
// original and correct job).
// Does the block name a place of its own? If so composePrompt must NOT append
// the video's recurring world, or the prompt carries two contradictory
// locations.
//
// This used to require a PREPOSITION-FIRST shape — in/at/on + article + ≤1 word
// + noun — which only matches when the sentence happens to be phrased that way.
// Measured 2026-08-26 on a live plan: "a man ... standing beside an open truck
// bed, carefully lifting a long, wrapped object into the truck, a rural
// driveway in the background" matched NOTHING and was shipped as "... a rural
// driveway in the background. Setting: a collector's private armory." Three
// separate place mentions, all missed: "beside" is not in the preposition list,
// "into" is not the word "in", and "driveway" came BEFORE its preposition. The
// very next block matched only by the incidental phrase "looking focused on the
// road", which is luck, not detection.
//
// The place NOUN is the signal; the grammar around it is noise. So match the
// noun wherever it appears. Over-matching is the safe direction here: a block
// that mentions a table, a truck or a shop genuinely does have a place, and
// leaving the recurring world off it costs nothing — the scene still describes
// itself. Appending a contradictory world is the failure that shows on screen.
const PLACE_RE =
  /\b(kitchen|counter|countertop|table|tabletop|aisle|shelf|shelves|rack|store|supermarket|market|stall|shop|storefront|showroom|armor?y|laboratory|lab|office|boardroom|desk|home|house|room|hall|hallway|garage|workshop|workbench|bench|yard|garden|lawn|field|farm|barn|shed|street|road|highway|roadside|lane|car|truck|tailgate|van|trailer|warehouse|factory|plant|mill|foundry|restaurant|cafe|diner|studio|clinic|hospital|classroom|library|museum|church|dock|harbour|harbor|beach|forest|woods|mountain|desert|trail|park|basement|attic|cellar|loft|porch|doorway|driveway|sidewalk|pavement|checkout|register|counter|freezer|fridge|refrigerator|pantry|cupboard|drawer|cabinet|safe|vault|case|crate|cart|trolley|auction|estate sale|yard sale|fair|tent|site|camp|mine|tunnel|deck|patio|balcony|rooftop|roof)\b/i;

export function blockNamesItsOwnPlace(blockPrompt: string | null | undefined): boolean {
  const p = (blockPrompt ?? "").trim();
  if (!p) return false;
  return PLACE_RE.test(p);
}

export function composePrompt(basePrompt: string, blockPrompt: string | null, shotType?: string | null): string | null {
  const base = basePrompt.trim();
  const block = (blockPrompt ?? "").trim();
  // Only a RECOGNISED camera framing may lead the prompt. An unrecognised value
  // is a stray phrase (see normalizeShotType) and is dropped, not prefixed.
  const shot = normalizeShotType(shotType) ?? "";
  // Lead with the shot type when present, then the scene-specific subject.
  const lead = [shot, block].filter(Boolean).join(": ");
  if (!base) return lead || null;
  if (!lead) return base;
  // Avoid a duplicated base if a block prompt already contains it (e.g. an edited
  // row re-run through the planner).
  if (lead.toLowerCase().includes(base.toLowerCase())) return lead;
  // The block already chose a place -- appending the world here would put two
  // contradictory locations in one prompt. See blockNamesItsOwnPlace.
  if (blockNamesItsOwnPlace(lead)) return lead.replace(/[.\s]+$/, "");
  // Subject/shot first; world as trailing context.
  return `${lead.replace(/[.\s]+$/, "")}. Setting: ${base.replace(/[.\s]+$/, "")}.`;
}

// The second visual covering a long sentence shows the SAME moment from a
// different composition so the two frames don't look like duplicates. We append
// a short variation hint to the block's own prompt (the full-sentence scene is
// unchanged). Returns the prompt untouched when this isn't a second visual.
function secondVisualPrompt(blockPrompt: string | null, isSecond?: boolean): string | null {
  if (!isSecond) return blockPrompt;
  const block = (blockPrompt ?? "").trim();
  if (!block) return block || null;
  return `${block.replace(/[.\s]+$/, "")}. Show this from a different angle and composition (alternate framing of the same scene).`;
}

function mk(
  s: z.infer<typeof GeminiSegmentSchema>,
  position: number,
  startTime: number,
  endTime: number,
): PlannedSegment {
  const isVisual = s.blockType !== "avatar";
  return {
    position,
    blockType: s.blockType,
    startTime,
    endTime,
    duration: Math.max(0.5, endTime - startTime),
    script: s.script.trim(),
    imagePrompt: isVisual ? (s.imagePrompt?.trim() || null) : null,
    shotType: isVisual ? (s.shotType?.trim() || null) : null,
    imagePrompt2: isVisual ? (s.imagePrompt2?.trim() || null) : null,
    shotType2: isVisual ? (s.shotType2?.trim() || null) : null,
    // Per-slot scenes for slots 3+ of a long sentence (see splitByDuration).
    // Entries with no prompt are dropped here so the splitter's fallback runs
    // instead of setting an empty imagePrompt.
    extraScenes: isVisual
      ? (s.extraScenes ?? [])
          .map((e) => ({ imagePrompt: (e.imagePrompt ?? "").trim(), shotType: (e.shotType ?? "").trim() }))
          .filter((e) => e.imagePrompt.length > 0)
      : [],
    animationPrompt: s.blockType === "ai_clip" ? (s.animationPrompt?.trim() || null) : null,
  };
}

// Carve a planned segment along avatar-mark boundaries.
//
// Doc marks are sub-sentence precise: a red/orange highlight can cover only the
// FIRST half of a Gemini block (e.g. "...maintenance habit." is marked but the
// trailing "Repeat it every two to three weeks..." in the SAME block is not).
// Forcing the whole block to avatar on any overlap mislabels the unmarked tail.
//
// Instead we intersect the block's char window [origStart, origEnd) with the
// marked ranges, producing alternating marked / unmarked runs, and emit one
// sub-segment per run. The script text and the spoken-time window are carved
// proportionally by character fraction within the block — exact enough for the
// review screen (per-block script/timing stay editable), and far better than
// promoting unmarked narration to a talking-head shot.
//
// A run that covers the whole block returns the block unchanged. Sub-segments
// inherit the parent's blockType for unmarked runs (so a non-avatar block stays
// whatever Gemini/the demote step chose) and become 'avatar' for marked runs.
interface MarkRun {
  start: number; // char offset into transcript, inclusive
  end: number; // exclusive
  marked: boolean;
  model: AvatarModel | null; // the model of the range covering this run (marked runs only)
}
export function intersectRuns(
  segStart: number,
  segEnd: number,
  ranges: AvatarMarkRange[],
): MarkRun[] {
  // Collect mark boundaries strictly inside (segStart, segEnd), build runs.
  const cuts = new Set<number>([segStart, segEnd]);
  for (const r of ranges) {
    if (r.start > segStart && r.start < segEnd) cuts.add(r.start);
    if (r.end > segStart && r.end < segEnd) cuts.add(r.end);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const runs: MarkRun[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b <= a) continue;
    const mid = (a + b) / 2;
    const covering = ranges.find((r) => r.start <= mid && mid < r.end);
    const marked = !!covering;
    const model = covering?.model ?? null;
    const last = runs[runs.length - 1];
    if (last && last.marked === marked && last.model === model) {
      last.end = b; // coalesce same-type + same-model adjacent runs
    } else {
      runs.push({ start: a, end: b, marked, model });
    }
  }
  return runs;
}

// Snap avatar mark ranges OUT to whole-sentence boundaries.
//
// The Google-Doc highlight is hand-drawn, so a red span routinely starts or ends
// MID-SENTENCE (observed: a mark covering "...we had two kids, a boy and" but
// stopping just before "a girl." in the same sentence). splitByMarks honors the
// exact char boundary, so it would carve that sentence into an avatar half ("a
// boy and") and a stranded visual fragment ("a girl.") — breaking the
// ONE-SENTENCE = ONE-BLOCK rule and leaking a fragment onto the next visual
// block. The avatar marking only ever needs SENTENCE granularity (a sentence is
// either spoken by the talking head or shown as B-roll, never half-and-half), so
// before any carving we EXPAND each range to the sentences it touches: a range
// that starts inside a sentence snaps back to that sentence's start, and one that
// ends inside a sentence snaps forward to that sentence's end. Adjacent/
// overlapping ranges are then re-merged. This is what kept marks sentence-aligned
// before; carving at the raw doc offset is what regressed.
export function snapRangesToSentences(
  transcript: string,
  ranges: AvatarMarkRange[],
): AvatarMarkRange[] {
  if (ranges.length === 0) return ranges;
  // Sentence boundaries: the offset just AFTER each terminal . ! ? (plus any
  // trailing quote/bracket), i.e. where the next sentence begins. 0 and the end
  // are implicit boundaries. We snap a range start back to the boundary at or
  // before it, and a range end forward to the boundary at or after it.
  const boundaries: number[] = [0];
  const re = /[.!?]+["')\]]*\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(transcript)) !== null) {
    const b = m.index + m[0].length;
    if (b > 0 && b < transcript.length) boundaries.push(b);
  }
  boundaries.push(transcript.length);
  // boundaries is sorted & unique by construction (regex advances monotonically).
  const sentenceStartAtOrBefore = (pos: number): number => {
    let lo = 0, hi = boundaries.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (boundaries[mid] <= pos) { ans = boundaries[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  };
  const sentenceEndAtOrAfter = (pos: number): number => {
    let lo = 0, hi = boundaries.length - 1, ans = transcript.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (boundaries[mid] >= pos) { ans = boundaries[mid]; hi = mid - 1; }
      else lo = mid + 1;
    }
    return ans;
  };

  // A hand-drawn highlight often includes the LEADING space before a sentence
  // (range starts on " Let me..." not "Let me..."), which sits one char before
  // the real sentence-start boundary and would snap the start back a whole extra
  // sentence. Anchor the snap on the first/last NON-whitespace char of the range
  // instead, so leading/trailing spaces in the highlight don't over-expand it.
  const firstNonWs = (from: number, to: number): number => {
    let i = from;
    while (i < to && /\s/.test(transcript[i])) i++;
    return Math.min(i, to);
  };
  const lastNonWs = (from: number, to: number): number => {
    let i = to - 1;
    while (i > from && /\s/.test(transcript[i])) i--;
    return Math.max(i, from);
  };
  const snapped = ranges
    .map((r) => {
      const a = firstNonWs(r.start, r.end);
      const b = lastNonWs(r.start, r.end);
      return {
        start: sentenceStartAtOrBefore(a),
        // Snap the end forward from the last non-ws char (end is exclusive) to
        // that sentence's end. A range ending on a boundary stays put.
        end: sentenceEndAtOrAfter(b + 1),
        model: r.model,
      };
    })
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  // Re-merge adjacent/overlapping ranges produced by the expansion — but only
  // ranges of the SAME model, so a red (Avatar IV) sentence abutting an orange
  // (Avatar III) one stays two ranges driving two different models.
  const merged: AvatarMarkRange[] = [];
  for (const r of snapped) {
    const last = merged[merged.length - 1];
    if (last && r.model === last.model && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

// Split `seg` (whose transcript char window is [origStart, origEnd)) into one
// sub-segment per mark run. `position` is assigned by the caller afterward.
export function splitByMarks(
  seg: PlannedSegment,
  origStart: number,
  origEnd: number,
  ranges: AvatarMarkRange[],
  basePrompt: string = "",
): PlannedSegment[] {
  const span = origEnd - origStart;
  const runs = span > 0 ? intersectRuns(origStart, origEnd, ranges) : [];
  // Whole-block (single run) — no carving needed; just label it.
  if (runs.length <= 1) {
    const marked = runs.length === 1 ? runs[0].marked : false;
    const model = runs.length === 1 ? runs[0].model : null;
    return [applyMark(seg, marked, basePrompt, model)];
  }

  const scriptLen = seg.script.length;
  const timeSpan = seg.endTime - seg.startTime;
  const out: PlannedSegment[] = [];
  for (const run of runs) {
    const f0 = (run.start - origStart) / span;
    const f1 = (run.end - origStart) / span;
    // Carve script text on a whitespace boundary near the proportional cut so
    // we don't slice a word in half.
    const rawStart = Math.round(f0 * scriptLen);
    const rawEnd = Math.round(f1 * scriptLen);
    const cutStart = run === runs[0] ? 0 : snapToSpace(seg.script, rawStart);
    const cutEnd = run === runs[runs.length - 1] ? scriptLen : snapToSpace(seg.script, rawEnd);
    const piece = seg.script.slice(cutStart, cutEnd).trim();
    if (!piece) continue;
    const startTime = seg.startTime + f0 * timeSpan;
    const endTime = seg.startTime + f1 * timeSpan;
    const sub: PlannedSegment = {
      ...seg,
      startTime,
      endTime,
      duration: Math.max(0.5, endTime - startTime),
      script: piece,
    };
    out.push(applyMark(sub, run.marked, basePrompt, run.model));
  }
  return out.length > 0
    ? out
    : [applyMark(seg, runs.some((r) => r.marked), basePrompt, runs.find((r) => r.marked)?.model ?? null)];
}

// Round a char index to the nearest whitespace boundary in `text` so a script
// carve lands between words, not mid-word.
function snapToSpace(text: string, idx: number): number {
  if (idx <= 0) return 0;
  if (idx >= text.length) return text.length;
  if (/\s/.test(text[idx])) return idx;
  let left = idx;
  while (left > 0 && !/\s/.test(text[left - 1])) left--;
  let right = idx;
  while (right < text.length && !/\s/.test(text[right])) right++;
  // Prefer the closer boundary.
  return idx - left <= right - idx ? left : right;
}

// Avatar parts are capped at 1 min by the content rules (well under HeyGen Pro's
// 5-min limit). Shared by coalesceAvatarSegments (which LOGS a warning if a
// merged avatar passage ever exceeds it) and mergeOrphansIntoAvatar (which
// SKIPS absorbing an orphan that would push the avatar over the cap).
const AVATAR_PART_MAX_SECONDS = 60;

// Merge consecutive SHORT visual segments so no single image/clip flashes by in
// ~1-2s (client feedback 2026-06: "the image switches are too often / only one
// second in between — slow everything down, make it ~5-6s").
//
// The synthetic timeline pins every block to its sentence's real spoken window
// (alignSegments). A short sentence therefore yields a short visual: live data
// showed ~50-65% of visual blocks under 5s, in long runs of back-to-back
// flashes. The duration-split pass only ever ADDS switches (it carves LONG
// sentences into two), so nothing upstream slows the short-sentence case — that
// is what this pass fixes.
//
// Rule: walk the timeline and, whenever a SHORT image/ai_clip block (shorter
// than SYNTHETIC_BLOCK_MIN_HOLD) sits next to a same-type image/ai_clip block,
// merge it INTO the previous block — concatenating the script and extending the
// spoken window to cover both. The trigger is EITHER block being under the
// minimum, so a short block also merges back into a previous block that is
// ALREADY at/above the minimum (the goal is "no visual under the minimum", not
// "grow until reached"). Merging stops at a non-mergeable block (avatar /
// split_2 / type change) or once the combined span passes the combine ceiling
// (~2 slots' worth); a short block with no mergeable neighbor falls through to
// the avatar pass or stays a rare orphan.
//
// Per client direction (2026-06): a SHORT sentence merges with its neighbor so
// the two render as ONE combined visual unit instead of a flash. Because the
// merged block covers BOTH sentences' narration, its visual must reflect the
// COMBINED thought — so we flag every merged block (`needsPromptRegen`) and the
// planner regenerates one combined imagePrompt for the merged script.
//
// The combined window may exceed the 8s cap — when it does, splitMergedVisuals
// (run after the regen) re-splits it into N EVEN ~min-second slots so it plays
// as N visuals of ~5s each (slot 1 = combined prompt, slots 2+ = a different
// angle), NOT one over-long hold. So a 7s + 2.6s pair → two ~4.8s visuals, and a
// clip+clip = 10s → two 5s clips with motion preserved (each slot < 8s).
//
// ONLY 'image' and 'ai_clip' merge, but they merge ACROSS types (a short
// sentence must never stay a flash, even next to the other visual type). The
// merged result type comes from resolveMerge: an 'ai_clip' if EITHER side was a
// clip (preserving motion for the clip-heavy intro), otherwise an 'image'.
// Merging is tried BACKWARD (into the
// previous visual), then FORWARD (into the next, for blocks whose previous
// neighbor is a boundary), then as an AVATAR fallback. 'avatar' and 'split_2'
// are explicitly NEVER a visual-merge target: avatar parts are atomic HeyGen
// renders handled by coalesceAvatarSegments (a stranded orphan can still be
// absorbed into an adjacent avatar's audio window — see mergeOrphansIntoAvatar),
// and split_2 is a presenter-beside-still layout that holds its whole sentence.
// Both act as visual-run boundaries.
const MERGEABLE_VISUAL_TYPES = new Set<SyntheticBlockType>(["image", "ai_clip"]);

// Upper bound on a COMBINED short-sentence window before merging stops absorbing
// more. A merged block over maxHold is later re-split into even ~min-second
// slots (splitMergedVisuals), so we don't need the old 8s cap here — but we DO
// cap the combine at ~2 slots' worth so a long run of shorts doesn't fuse into
// one block that re-splits into many near-identical visuals. 2*maxHold (16s)
// re-splits into at most ~3 slots, which is plenty.
const MERGE_COMBINE_CEILING_FACTOR = 2;

// Decide whether two adjacent visual blocks can merge and, if so, the result
// type. The result is an ai_clip when EITHER side is a clip (so motion is
// preserved — each re-split slot is < maxHold, well inside LTX's range), else an
// image. We allow the combined span to exceed maxHoldSeconds (the merged block
// is re-split into even ~min-second slots afterward — client direction 2026-06:
// a 7s + 2.6s pair merges to 9.6s and shows as TWO ~4.8s visuals, not one flash
// and not a long static hold). We only refuse once the combined span passes the
// combine ceiling, to avoid fusing a long run of shorts into one block.
function resolveMerge(
  a: PlannedSegment,
  b: PlannedSegment,
  spanSeconds: number,
  maxHoldSeconds: number,
): SyntheticBlockType | null {
  if (spanSeconds > maxHoldSeconds * MERGE_COMBINE_CEILING_FACTOR) return null;
  return a.blockType === "ai_clip" || b.blockType === "ai_clip" ? "ai_clip" : "image";
}

export function mergeShortVisualSegments(
  segs: PlannedSegment[],
  minHoldSeconds: number,
  maxHoldSeconds: number,
): { segments: PlannedSegment[]; merged: number } {
  const out: PlannedSegment[] = [];
  let merged = 0;
  for (const seg of segs) {
    const prev = out[out.length - 1];
    const mergeable =
      prev != null &&
      MERGEABLE_VISUAL_TYPES.has(prev.blockType) &&
      MERGEABLE_VISUAL_TYPES.has(seg.blockType);
    // Merge when EITHER block is under the minimum hold — the goal is "no visual
    // under the minimum", not "grow blocks until they reach it". So a SHORT
    // block (seg) merges back into the previous block even if that block is
    // already >= the minimum (e.g. a 6s image followed by a 1s "She's right."
    // flash → one 7s image), and a still-short open block keeps absorbing
    // following blocks. resolveMerge decides the result type (clip if either
    // side is a clip, else image) and returns null when the merged span won't
    // fit the cap — in which case the merge is skipped, never forced into a
    // long static hold.
    const bothShortTrigger =
      mergeable && (seg.duration < minHoldSeconds || prev!.duration < minHoldSeconds);
    const resultType = bothShortTrigger
      ? resolveMerge(prev!, seg, seg.endTime - prev!.startTime, maxHoldSeconds)
      : null;
    if (resultType) {
      prev!.script = `${prev!.script} ${seg.script}`.replace(/\s+/g, " ").trim();
      prev!.endTime = seg.endTime;
      prev!.duration = Math.max(0.5, prev!.endTime - prev!.startTime);
      // Result type from resolveMerge: ai_clip (motion kept) when either side is
      // a clip, else image. The combined-prompt regen below (re)derives the
      // animationPrompt only for a clip result.
      prev!.blockType = resultType;
      if (resultType === "image") prev!.animationPrompt = null;
      // The merged block now covers two sentences — its stored prompt is the
      // FIRST sentence's only, so mark it for a combined-prompt regen.
      prev!.needsPromptRegen = true;
      merged++;
      continue;
    }
    out.push({ ...seg });
  }

  // Forward visual-merge pass. The backward pass above only folds a short block
  // into the PREVIOUS visual, so a short block whose previous neighbor is a
  // boundary (split_2 / avatar) — but whose NEXT neighbor is a mergeable
  // image/ai_clip — never got a chance to merge (e.g. split_2, then a 3s image,
  // then an ai_clip: the 3s image couldn't go back into the split_2 and the
  // backward pass never looks forward). This pass absorbs such a short block
  // into the FOLLOWING visual instead, keeping the visual-merge-first priority
  // before the avatar fallback. Same cross-type rule (result is ai_clip if
  // either side was a clip) and max-hold cap.
  const fwdMerged = mergeShortVisualsForward(out, minHoldSeconds, maxHoldSeconds);
  merged += fwdMerged;

  // Avatar-fallback pass (client direction 2026-06). A SHORT image/ai_clip that
  // still has NO mergeable visual neighbor after the passes above (e.g. one
  // stranded between a split_2 and an avatar) is absorbed into an ADJACENT
  // AVATAR block instead of staying a ~1-2s flash. We prefer a visual merge
  // first (handled above); only true orphans reach here.
  //
  // Mechanic: an avatar block is an atomic HeyGen render lip-synced to a SLICE
  // of master_voiceover.mp3 over its [startTime, endTime) window. The master
  // voiceover already contains the orphan's spoken words in that time range, so
  // we just EXTEND the avatar's window to cover the orphan (start back for an
  // orphan before the avatar, end forward for one after) — the re-sliced audio
  // then includes the orphan's line and the talking head speaks it. No new
  // visual is generated. We also append the orphan's text to the avatar script
  // so the editor row mirrors what's spoken. split_2 is still NEVER a target
  // (two render paths) — an orphan next to only a split_2 stays as-is.
  const avMerged = mergeOrphansIntoAvatar(out, minHoldSeconds);
  merged += avMerged;
  return { segments: out, merged };
}

// Absorb a SHORT image/ai_clip into the FOLLOWING image/ai_clip when it could
// not merge backward (its previous neighbor was a split_2/avatar boundary).
// Mutates `segs` in place by removing absorbed orphans and extending the next
// block's window/script back over them; returns how many were absorbed. Same
// cross-type rule as the backward pass (the merged block is an ai_clip if either
// side was a clip) and the same max-hold cap. The next block's prompt is the
// SECOND sentence's, so the merged block is flagged for a combined-prompt regen.
function mergeShortVisualsForward(
  segs: PlannedSegment[],
  minHoldSeconds: number,
  maxHoldSeconds: number,
): number {
  let absorbed = 0;
  let i = 0;
  while (i < segs.length) {
    const seg = segs[i];
    const next = segs[i + 1];
    const isShortVisual =
      MERGEABLE_VISUAL_TYPES.has(seg.blockType) && seg.duration < minHoldSeconds;
    const nextMergeable =
      next != null && MERGEABLE_VISUAL_TYPES.has(next.blockType);
    const resultType =
      isShortVisual && nextMergeable
        ? resolveMerge(seg, next, next.endTime - seg.startTime, maxHoldSeconds)
        : null;
    if (resultType) {
      next.script = `${seg.script} ${next.script}`.replace(/\s+/g, " ").trim();
      next.startTime = seg.startTime;
      next.duration = Math.max(0.5, next.endTime - next.startTime);
      next.blockType = resultType;
      if (resultType === "image") next.animationPrompt = null;
      next.needsPromptRegen = true;
      segs.splice(i, 1); // remove the orphan; the next block shifts to index i
      absorbed++;
      continue; // re-check index i (the merged block may now absorb more)
    }
    i++;
  }
  return absorbed;
}

// Absorb SHORT visual orphans (image/ai_clip under the min hold with no
// mergeable visual neighbor) into an adjacent avatar block, extending the
// avatar's spoken window to cover the orphan. Mutates `segs` in place by
// removing absorbed orphans, and returns how many were absorbed.
//
// Direction: prefer the PREVIOUS block (extend its endTime forward to the
// orphan's end) so the avatar that just finished talking simply keeps talking
// through the short line; otherwise the NEXT block (extend its startTime back to
// the orphan's start). split_2 is never a target. We respect the avatar 60s cap
// — an absorb that would push the avatar over the cap is skipped (the orphan
// stays, a rare case). The orphan's script is appended (prev) or prepended
// (next) to the avatar so the editor row mirrors the spoken audio.
function mergeOrphansIntoAvatar(segs: PlannedSegment[], minHoldSeconds: number): number {
  let absorbed = 0;
  let i = 0;
  while (i < segs.length) {
    const seg = segs[i];
    const isShortVisual =
      MERGEABLE_VISUAL_TYPES.has(seg.blockType) && seg.duration < minHoldSeconds;
    if (!isShortVisual) { i++; continue; }
    const prev = segs[i - 1];
    const next = segs[i + 1];
    const prevAvatarOk =
      prev?.blockType === "avatar" &&
      seg.endTime - prev.startTime <= AVATAR_PART_MAX_SECONDS;
    const nextAvatarOk =
      next?.blockType === "avatar" &&
      next.endTime - seg.startTime <= AVATAR_PART_MAX_SECONDS;
    if (prevAvatarOk) {
      prev.script = `${prev.script} ${seg.script}`.replace(/\s+/g, " ").trim();
      prev.endTime = seg.endTime;
      prev.duration = Math.max(0.5, prev.endTime - prev.startTime);
      segs.splice(i, 1); // remove the orphan; do not advance i
      absorbed++;
      continue;
    }
    if (nextAvatarOk) {
      next.script = `${seg.script} ${next.script}`.replace(/\s+/g, " ").trim();
      next.startTime = seg.startTime;
      next.duration = Math.max(0.5, next.endTime - next.startTime);
      segs.splice(i, 1); // remove the orphan; the avatar shifts to index i
      absorbed++;
      continue;
    }
    i++;
  }
  return absorbed;
}

// Re-split a MERGED visual block whose combined window is longer than maxHold
// into N even slots so it shows as N visuals of ~minHold each, instead of one
// over-long hold (client direction 2026-06: a 7s + 2.6s pair merges to 9.6s and
// plays as TWO ~4.8s images, "half the time each"). Mirrors splitByDuration but
// produces N EVEN slots (N = round(dur / minHold), at least 2) rather than two
// halves, and operates on the post-merge block.
//
// Only blocks flagged needsPromptRegen (i.e. blocks this pass's merge actually
// combined) are re-split here; a naturally-long Gemini block was already carved
// by the earlier duration-split pass. Slot 1 keeps the merged block's
// (regenerated, combined) prompt; slots 2+ are flagged secondVisual so persist
// appends the "different angle" variation — distinct compositions of the same
// combined thought. Each slot inherits the merged blockType (an ai_clip stays an
// ai_clip; each slot < maxHold so it's inside LTX's range, motion preserved).
// Returns a new array; positions are renumbered by the caller.
export function splitMergedVisuals(
  segs: PlannedSegment[],
  minHoldSeconds: number,
  maxHoldSeconds: number,
): { segments: PlannedSegment[]; split: number } {
  const out: PlannedSegment[] = [];
  let split = 0;
  for (const seg of segs) {
    const dur = seg.endTime - seg.startTime;
    if (!seg.needsPromptRegen || !MERGEABLE_VISUAL_TYPES.has(seg.blockType) || dur <= maxHoldSeconds) {
      out.push(seg);
      continue;
    }
    const slots = Math.max(2, Math.round(dur / minHoldSeconds));
    for (let k = 0; k < slots; k++) {
      const startTime = seg.startTime + (k * dur) / slots;
      const endTime = seg.startTime + ((k + 1) * dur) / slots;
      out.push({
        ...seg,
        startTime,
        endTime,
        duration: Math.max(0.5, endTime - startTime),
        // Slot 1 carries the combined prompt as-is; later slots show a different
        // angle/composition of the same combined thought.
        secondVisual: k > 0,
      });
    }
    split++;
  }
  return { segments: out, split };
}

// FINAL position-based image/ai_clip balance (client 2026-06-30: "first 3 min
// should be many ai_clip, after that image and ai_clip should appear NATURALLY"
// — not all-clip). Must run LAST, after all merge/split churn, because the
// short-visual merge biases every merge to ai_clip (resolveMerge returns ai_clip
// when EITHER side is a clip), which snowballed one plan to 100 clips / 15
// images. This pass is the final word on visual type:
//   * a visual block (image/ai_clip) STARTING before `clipHeavyCutoff` follows a
//     repeating run pattern of `introClipRun` clips then `introImageRun` images
//     (client 2026-07-03: all-clip intro was too expensive — wants
//     "ai clip - ai clip - image - image" for the first 3 min). introImageRun 0
//     restores the old all-clip intro.
//   * after the cutoff -> keep only a `postClipFraction` share as ai_clip,
//     spaced EVENLY across the post-cutoff visuals (every Nth), the rest demoted
//     to image. Even spacing avoids a clump of clips then a clump of stills.
// avatar / split_2 are NEVER touched (different render paths). A block flipped
// to image loses its animationPrompt (a still has no motion); a block flipped to
// ai_clip gets a null animationPrompt here and has one written for it by the
// fill pass at the end of the plan (see generateAnimationPrompts).
//
// Pre-cutoff mix (client 2026-07-22: "30% clips - 70% images for the first 15
// mins"): when `introClipFraction` > 0 the window uses the SAME even-spacing
// stride as the post-cutoff zone at that fraction, so the ratio is exact and
// clips never clump. When 0, the legacy clipRun/imageRun repeating pattern
// applies instead.
export function balanceVisualTypesByPosition(
  segs: PlannedSegment[],
  clipHeavyCutoffSeconds: number,
  postClipFraction: number,
  introClipRun: number = 2,
  introImageRun: number = 2,
  introClipFraction: number = 0,
): { segments: PlannedSegment[]; toClip: number; toImage: number } {
  let toClip = 0;
  let toImage = 0;
  // Index among PRE-cutoff visual blocks, used to walk the clip/image run
  // pattern (e.g. 2/2 -> clip clip image image clip clip …) or the fraction
  // stride.
  let preIdx = 0;
  // Index among POST-cutoff visual blocks, used to space clips evenly. We keep a
  // clip when floor(i * frac) increments — a classic even-distribution stride.
  let postIdx = 0;
  const clipRun = Math.max(1, Math.floor(introClipRun));
  const imageRun = Math.max(0, Math.floor(introImageRun));
  // Even-spacing decision: keep a clip when the running quota ticks up.
  const strideClip = (i: number, frac: number) =>
    frac >= 1 ? true : frac <= 0 ? false : Math.floor((i + 1) * frac) > Math.floor(i * frac);
  const out = segs.map((seg) => {
    if (seg.blockType !== "image" && seg.blockType !== "ai_clip") return seg;
    const beforeCutoff = clipHeavyCutoffSeconds > 0 && seg.startTime < clipHeavyCutoffSeconds;
    let want: SyntheticBlockType;
    if (beforeCutoff) {
      const i = preIdx++;
      if (introClipFraction > 0) {
        // Phase-shifted stride so the WINDOW OPENS on a clip (moving footage
        // first, per the reference channel), then e.g. 0.3 -> clip img img img
        // clip … — still exactly the fraction over the window.
        want = i === 0 || strideClip(i - 1, introClipFraction) ? "ai_clip" : "image";
      } else {
        want = imageRun <= 0 || i % (clipRun + imageRun) < clipRun ? "ai_clip" : "image";
      }
    } else {
      want = strideClip(postIdx++, postClipFraction) ? "ai_clip" : "image";
    }
    if (want === seg.blockType) return seg;
    if (want === "ai_clip") { toClip++; return { ...seg, blockType: "ai_clip" as SyntheticBlockType }; }
    toImage++;
    return { ...seg, blockType: "image" as SyntheticBlockType, animationPrompt: null };
  });
  return { segments: out, toClip, toImage };
}

// van der Corput (radix-2) sequence. The point of it here: ANY PREFIX of the
// resulting order is evenly spread over 0..n-1 — vdc gives 0, .5, .25, .75,
// .125 … so taking the first k items lands them across the whole timeline for
// every k, not just a k chosen up front.
//
// That property is what the quota pass needs and a plain stride cannot give:
// how many blocks fit in a SECONDS budget isn't known until we're partway
// through adding them up (blocks differ in length), so the selection order has
// to stay evenly spread no matter where we stop.
function vanDerCorput(i: number): number {
  let n = i;
  let base = 0.5;
  let q = 0;
  while (n > 0) {
    q += (n % 2) * base;
    n = Math.floor(n / 2);
    base /= 2;
  }
  return q;
}

/** Indices 0..n-1 ordered so that every prefix is evenly spread across them. */
function spreadOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
    .map((i) => ({ i, key: vanDerCorput(i) }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((x) => x.i);
}

// Does this scene contain a person who could plausibly PERFORM an action? An
// ai_clip is now defined by human movement (ACTION_CLIP_RULE), so promoting a
// still-life — a jar on a shelf, an empty field — into one produces either the
// "random zoom" the client rejected or a hallucinated person appearing from
// nowhere. Blocks whose prompt names a person or a hands-on action are
// therefore preferred when filling the clip budget.
//
// Deliberately a loose keyword test on the prompt text, not a model call: it
// only has to ORDER candidates (a wrong guess costs one mediocre clip, never a
// failure), and the pass has to stay pure and instant.
const ACTION_SCENE_RE =
  /\b(she|he|her|his|their|they|woman|man|person|people|hand|hands|holding|hold|pour|pours|pouring|stir|stirs|stirring|mix|mixes|mixing|cut|cuts|cutting|chop|slice|lift|lifts|lifting|wipe|wipes|plant|plants|planting|water|watering|spray|sprays|clean|cleans|cooking|cooks|adds|adding|placing|places|picking|picks|carry|carries|open|opens|opening|pressing|presses|scoop|scoops|spread|spreads|rub|rubs|kneading|knead)\b/i;

function canCarryAction(seg: PlannedSegment): boolean {
  return ACTION_SCENE_RE.test(`${seg.imagePrompt ?? ""} ${seg.script ?? ""}`);
}

// ---------------------------------------------------------------------------
// WITHIN-VIDEO SCENE REPETITION (client 2026-08-19 via Joey: "for example the
// german video, it is showing spoons a lot, very similar images and similar
// footages. I want more variation").
//
// The existing distinct-second-visual pass only compares the extra visuals of
// ONE sentence. Repetition across the whole script was invisible to it: a script
// that keeps returning to its subject produced dozens of individually-reasonable
// prompts that all render as the same picture. These helpers find those runs so
// the planner can regenerate the later ones against the earlier ones.
//
// The measure is a Jaccard overlap of CONTENT WORDS, not an embedding: it has to
// stay pure and instant (it runs over every block of a 300-block plan), and the
// failure it catches is lexical almost by construction — near-identical prompts
// come from near-identical sentences.

// Words that carry no scene identity. Overlap on these is what made a naive
// comparison call every prompt similar to every other.
const SCENE_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for", "with",
  "from", "by", "as", "is", "are", "was", "were", "be", "being", "been", "it",
  "its", "this", "that", "these", "those", "there", "here", "into", "onto",
  "over", "under", "up", "down", "out", "off", "near", "next", "beside",
  // Prompt/craft boilerplate — present in nearly every prompt we emit, so it
  // must not count as shared subject matter.
  "shot", "close", "closeup", "wide", "macro", "angle", "view", "scene",
  "photo", "photograph", "image", "footage", "clip", "frame", "framing",
  "composition", "lighting", "light", "soft", "natural", "realistic", "real",
  "detailed", "detail", "quality", "background", "foreground", "setting",
  "style", "camera", "focus", "slight", "slightly", "very", "showing", "shows",
  "show", "shown", "seen", "visible", "looks", "looking",
]);

/**
 * Content words of a prompt, lowercased and de-duplicated.
 *
 * `exclude` removes the shared base-prompt vocabulary. That matters: during
 * planning a block's `imagePrompt` is the scene alone, but a prompt that came
 * back from regenerateSegmentPrompt already has the base folded in (and persist
 * folds it into the rest), so without this the two shapes would score as far
 * more similar than the scenes actually are.
 */
export function sceneWords(text: string, exclude?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    // Length 3 keeps "jar"/"pan"/"oil" while dropping inflectional noise.
    if (raw.length < 3) continue;
    if (SCENE_STOPWORDS.has(raw)) continue;
    if (exclude?.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** Jaccard overlap of two word sets. 1 = identical vocabulary, 0 = disjoint. */
export function sceneSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const w of small) if (large.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** One block flagged as a repeat, with the earlier scenes it must differ from. */
export interface RepeatedScene {
  index: number;      // index into the array passed in
  avoid: string[];    // earlier prompt(s) this block duplicates
  anchor: number;     // index of the closest earlier match — chains group on it
  similarity: number;
}

/**
 * Flag blocks whose scene repeats an earlier one.
 *
 * Walks the plan in order keeping a list of ACCEPTED scenes. A block similar
 * enough to an accepted scene is flagged (and deliberately NOT accepted — its
 * prompt is about to be replaced, so admitting it would let later blocks
 * de-duplicate against a scene that is going away). Everything else is accepted
 * and becomes a reference for later blocks.
 *
 * `window` bounds the comparison to the last N visual blocks: repetition reads
 * as repetition when the viewer can still remember the earlier shot, and a
 * callback to a subject twenty minutes later is fine. 0 compares against the
 * whole video.
 *
 * `maxRegen` caps how many are flagged — each one costs a Gemini call. The
 * caller reports the overflow rather than silently truncating.
 */
// SAME PICTURE, DIFFERENT WORDS.
//
// findRepeatedScenes below compares CONTENT WORDS, which catches near-clones and
// nothing else. Measured 2026-08-26 on five CONSECUTIVE live blocks that were
// all "a person's hand + a ground turkey package + a label":
//
//   pairwise word overlap 0.24 - 0.52   ->  flagged at 0.70: 0   at 0.55: 0
//
// You would need a threshold near 0.25 to catch them, which would flag nearly
// every block in the video. Lexical similarity is blind to a repeated
// COMPOSITION described in different vocabulary, and that composition is exactly
// what the client keeps reporting ("the footage is so repetitive").
//
// So compare the SHAPE of the shot instead of its wording:
//   - is a hand/body the subject?
//   - what is the framing (the shotType prefix)?
//   - which concrete OBJECT nouns appear, as a set?
//
// The five examples above all reduce to hands + package/label, and collapse onto
// one signature. Two shots of the same object at different framings do NOT
// collapse, which is the variety we want to keep.
const SIG_STOP = new Set([
  "close", "closeup", "wide", "medium", "macro", "shot", "angle", "view", "scene",
  "photo", "image", "frame", "framing", "establishing", "product", "level",
  "ground", "low", "high", "over", "shoulder", "with", "that", "this", "from",
  "into", "onto", "showing", "shown", "visible", "background", "foreground",
  "focus", "detail", "details", "small", "large", "generic", "simple", "clean",
  "brightly", "lit", "dark", "light", "some", "several", "various", "partially",
  "almost", "very", "real", "clearly", "slightly",
]);

const BODY_RE = /\b(hands?|fingers?|palm|arms?|person|people|man|woman|shopper|customer)\b/i;

/**
 * A coarse fingerprint of WHAT THE PICTURE IS, independent of how it is worded.
 *
 * Exported for testing: the value is opaque, only equality between two prompts
 * is meaningful.
 */
export function compositionSignature(prompt: string | null | undefined): string {
  const raw = (prompt ?? "").trim();
  if (!raw) return "";
  // Drop the appended world and the shot-type prefix -- neither says what the
  // subject IS, and both are shared by most blocks.
  const body = raw.replace(/\.\s*Setting:[\s\S]*$/i, "").replace(/^[^:]{0,40}:\s*/, "");
  const hasBody = BODY_RE.test(body) ? "body" : "nobody";
  // KEEP THEM ALL. An earlier version sorted and took the first six, which is
  // alphabetical truncation: "…back, held, ingredients, list, meat" survived
  // while "package" and "turkey" -- the actual subject -- were cut. Two shots of
  // the same thing then shared none of the words that made them the same shot.
  const nouns = [
    ...new Set(
      body
        .toLowerCase()
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !SIG_STOP.has(w) && !BODY_RE.test(w)),
    ),
  ].sort();
  return `${hasBody}|${nouns.join(",")}`;
}

export interface RepeatedComposition {
  index: number;
  signature: string;
  avoid: string[];
  anchor: number;
}

/**
 * Blocks whose SHOT SHAPE repeats one already used within `window` accepted
 * visuals. Same contract as findRepeatedScenes so both feed one regeneration
 * pass: the first use of a composition is kept, later ones are flagged.
 *
 * `minShared` is how many signature nouns two shots must have in common (on top
 * of agreeing about whether a body is in frame) before they count as the same
 * picture. 2 is deliberately loose -- "hands + package" and "hands + label" are
 * the same shot to a viewer even though only one noun matches, but requiring 2
 * keeps unrelated scenes apart.
 */
export function findRepeatedCompositions(
  scenes: ReadonlyArray<string | null>,
  opts: { window: number; maxRegen: number; minShared?: number },
): { repeats: RepeatedComposition[]; flaggedTotal: number } {
  const minShared = opts.minShared ?? 2;
  const accepted: { index: number; sig: string; nouns: Set<string>; body: string; text: string }[] = [];
  const repeats: RepeatedComposition[] = [];
  let flaggedTotal = 0;

  for (let i = 0; i < scenes.length; i++) {
    const text = (scenes[i] ?? "").trim();
    if (!text) continue;
    const sig = compositionSignature(text);
    if (!sig) continue;
    const [body, nounCsv] = sig.split("|");
    const nouns = new Set(nounCsv ? nounCsv.split(",") : []);
    if (nouns.size === 0) {
      accepted.push({ index: i, sig, nouns, body, text });
      continue;
    }

    let match: (typeof accepted)[number] | null = null;
    for (let k = accepted.length - 1; k >= 0; k--) {
      const cand = accepted[k];
      if (opts.window > 0 && accepted.length - k > opts.window) break;
      if (cand.body !== body) continue;
      let shared = 0;
      for (const n of nouns) if (cand.nouns.has(n)) shared++;
      if (shared >= minShared) {
        match = cand;
        break;
      }
    }

    if (match) {
      flaggedTotal++;
      if (repeats.length < opts.maxRegen) {
        repeats.push({ index: i, signature: sig, avoid: [match.text], anchor: match.index });
      }
      continue;
    }
    accepted.push({ index: i, sig, nouns, body, text });
  }
  return { repeats, flaggedTotal };
}

export function findRepeatedScenes(
  scenes: ReadonlyArray<string | null>,
  opts: { basePrompt?: string; similarity: number; window: number; maxRegen: number },
): { repeats: RepeatedScene[]; flaggedTotal: number } {
  const exclude = opts.basePrompt ? sceneWords(opts.basePrompt) : undefined;
  const accepted: { index: number; words: Set<string>; text: string }[] = [];
  const repeats: RepeatedScene[] = [];
  let flaggedTotal = 0;

  for (let i = 0; i < scenes.length; i++) {
    const text = (scenes[i] ?? "").trim();
    if (!text) continue;
    const words = sceneWords(text, exclude);
    // A prompt with almost no distinctive vocabulary left can't be judged.
    if (words.size < 3) { accepted.push({ index: i, words, text }); continue; }

    let bestSim = 0;
    let bestAt = -1;
    const matches: string[] = [];
    for (let k = accepted.length - 1; k >= 0; k--) {
      const cand = accepted[k];
      // `window` counts ACCEPTED scenes back, not raw block distance, so an
      // avatar-heavy stretch doesn't push the comparison window past the
      // visuals the viewer actually saw.
      if (opts.window > 0 && accepted.length - k > opts.window) break;
      const sim = sceneSimilarity(words, cand.words);
      if (sim >= opts.similarity) {
        matches.push(cand.text);
        if (sim > bestSim) { bestSim = sim; bestAt = cand.index; }
      }
    }

    if (bestAt >= 0) {
      flaggedTotal++;
      // Cap the avoid list: Gemini needs the shape of what's taken, not every
      // instance, and a long list crowds out the script in the prompt budget.
      if (repeats.length < opts.maxRegen) {
        repeats.push({ index: i, avoid: matches.slice(0, 3), anchor: bestAt, similarity: bestSim });
      }
      continue;
    }
    accepted.push({ index: i, words, text });
  }
  return { repeats, flaggedTotal };
}

export interface ClipQuotaResult {
  segments: PlannedSegment[];
  totalSeconds: number;
  targetClipSeconds: number;   // LTX + veo combined
  targetVeoSeconds: number;
  clipSeconds: number;         // achieved, LTX + veo
  veoSeconds: number;          // achieved
  promoted: number;            // image -> ai_clip
  demoted: number;             // ai_clip -> image
  veoBlocks: number;
  ltxBlocks: number;
  // Seconds by which the clip budget could NOT be met, because there were not
  // enough eligible visual blocks (see the avatar-marking note below). 0 when
  // the target was reached.
  shortfallSeconds: number;
  // Per-phase breakdown (client 2026-08-18 two-phase mix). One entry per phase
  // in the order given; a single-phase call reports one entry. Logged so a
  // mix complaint can be traced to the phase that missed rather than to the
  // video-wide average, which hides a starved opening window.
  phases: ClipQuotaPhaseResult[];
}

/** One phase of the duration budget — a time window with its own clip shares. */
export interface ClipPhase {
  // Video-time window this phase governs, by block START time: [start, end).
  startSeconds: number;
  endSeconds: number;     // Infinity for the final phase
  clipFraction: number;   // LTX share of the phase's basis seconds
  veoFraction: number;    // veo share of the phase's basis seconds
  label: string;          // for logs, e.g. "phase1"
}

export interface ClipQuotaPhaseResult {
  label: string;
  startSeconds: number;
  endSeconds: number;
  // Seconds the fractions were measured against — total block seconds in the
  // window under basis "total", or just the image/ai_clip seconds under "visual".
  basisSeconds: number;
  targetClipSeconds: number;
  targetVeoSeconds: number;
  clipSeconds: number;
  veoSeconds: number;
  shortfallSeconds: number;
  ltxBlocks: number;
  veoBlocks: number;
}

/**
 * Enforce the client's CLIP BUDGET BY DURATION, IN TIME PHASES.
 *
 * Client 2026-08-20 (Joey): "The first 3 min, 65 % ltx clips and 35 % images.
 * After 3 mins, 70% images and 30% clips." (Phase 2's 30% is the 20% LTX + 10%
 * VEO already set on 2026-08-18; only the opening window changed, trimmed from
 * 4 min @ 80% to 3 min @ 65% to cut LTX spend.) Each phase is a video-time
 * window with its own LTX and veo shares, filled INDEPENDENTLY from that
 * window's own blocks — a single whole-video budget cannot express this,
 * because an evenly-spread 30% budget puts ~30% in the opening window, not 65%.
 *
 * This is deliberately a DURATION pass, not a count pass. The older
 * balanceVisualTypesByPosition works on block COUNT and POSITION, and a count
 * share does not yield a duration share when blocks differ in length — a plan
 * can be 30% clips by count and 12% by screen time. This runs after it and is
 * authoritative for the final mix.
 *
 * WHAT IT WILL NOT TOUCH: 'avatar' and 'split_2' blocks. Avatar blocks are not
 * ours to reassign — they come from the red/orange highlights in the client's
 * Google Doc (see doc-marks.ts), so the avatar share of a video is fixed by the
 * source document. The clip budget is therefore drawn only from the visual
 * (image/ai_clip) remainder, and on a heavily-highlighted doc the target can be
 * genuinely unreachable. That case reports `shortfallSeconds` rather than
 * failing: silently missing the target is what makes it undiagnosable.
 *
 * BASIS (see SYNTHETIC_CLIP_FRACTION_BASIS): "visual" measures the percentages
 * against the image + ai_clip seconds in the phase — the pool this pass can
 * actually reassign, and the reading under which the client's numbers sum to 100
 * (65+35, 70+20+10). "total" measures against every block in the phase including
 * avatar / split_2, the pre-2026-08-18 behaviour.
 *
 * Back-compat: the single-fraction opts shape ({clipFraction, veoFraction, …})
 * is still accepted and is treated as one whole-video phase on the "total"
 * basis, which is exactly what it used to mean.
 */
/**
 * Build clip phases from SYNTHETIC_CLIP_SCHEDULE.
 *
 * The client's 2026-08-22 spec is a per-minute table of animated seconds that
 * DECAYS across the video (85% in minute 1 down to 0 by ~14 minutes). The
 * two-phase model cannot express a curve: it has exactly one step. Each schedule
 * entry becomes one phase running until the next entry starts.
 *
 * Format: "0:0.85,60:0.80,...". Malformed entries are skipped rather than
 * throwing — a typo in a Fly secret should degrade to the two-phase default, not
 * take the planner down mid-render.
 *
 * Returns [] when unset/unusable, which is the caller's signal to fall back.
 */
export function parseClipSchedule(raw: string | undefined, veoShare: number): ClipPhase[] {
  if (!raw || !raw.trim()) return [];
  const points: { start: number; fraction: number }[] = [];
  for (const part of raw.split(",")) {
    const [s, f] = part.split(":");
    const start = Number((s ?? "").trim());
    const fraction = Number((f ?? "").trim());
    if (!Number.isFinite(start) || start < 0) continue;
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
    points.push({ start, fraction });
  }
  if (points.length === 0) return [];
  points.sort((a, b) => a.start - b.start);

  return points.map((p, i) => {
    // veoShare splits each bucket's ANIMATED seconds between the two providers;
    // the schedule itself says only how much of the window is animated, matching
    // the client's table which does not name a provider.
    const veoFraction = p.fraction * veoShare;
    return {
      startSeconds: p.start,
      endSeconds: i + 1 < points.length ? points[i + 1].start : Infinity,
      clipFraction: p.fraction - veoFraction,
      veoFraction,
      label: `sched_${Math.round(p.start)}s`,
    };
  });
}

export function assignClipDurationQuota(
  segs: PlannedSegment[],
  opts: {
    veoEnabled: boolean;
    // Restrict the budget to blocks starting before this many seconds (the
    // "no LTX after 15 minutes" cost guard). 0 = the whole video is eligible.
    cutoffSeconds: number;
    // Two-phase (or n-phase) form. Takes precedence over clipFraction below.
    phases?: ClipPhase[];
    basis?: "visual" | "total";
    // Legacy single-phase form — a whole-video budget on the "total" basis.
    clipFraction?: number;
    veoFraction?: number;
  },
): ClipQuotaResult {
  const dur = (s: PlannedSegment) => Math.max(0, Number(s.duration) || 0);
  const totalSeconds = segs.reduce((a, s) => a + dur(s), 0);
  const veoOn = opts.veoEnabled;

  // Normalize both call shapes to a phase list. The legacy shape keeps the
  // "total" basis regardless of the basis option, so an old caller's numbers
  // never silently change meaning.
  const legacy = !opts.phases || opts.phases.length === 0;
  const phases: ClipPhase[] = legacy
    ? [{
        startSeconds: 0,
        endSeconds: Infinity,
        clipFraction: Math.max(0, opts.clipFraction ?? 0),
        veoFraction: Math.max(0, opts.veoFraction ?? 0),
        label: "all",
      }]
    : opts.phases!;
  const basis: "visual" | "total" = legacy ? "total" : (opts.basis ?? "visual");

  // Which blocks this pass may reassign at all: image / ai_clip inside the
  // cost-guard cutoff. Everything else keeps its type no matter the phase.
  const isVisual = (s: PlannedSegment) => s.blockType === "image" || s.blockType === "ai_clip";
  const inCutoff = (s: PlannedSegment) => !(opts.cutoffSeconds > 0 && s.startTime >= opts.cutoffSeconds);

  // Preference tiers for filling a budget — best clip candidates first.
  //
  //   3  already ai_clip AND the scene has a person/action  (Gemini picked it
  //      as a dynamic scene and it can carry the movement)
  //   2  already ai_clip                                    (chosen as dynamic)
  //   1  a still whose scene has a person/action            (promotes cleanly)
  //   0  any other still                                    (last resort — an
  //      action prompt over a still-life is the weakest clip we can make)
  const tierOf = (i: number) =>
    (segs[i].blockType === "ai_clip" ? 2 : 0) + (canCarryAction(segs[i]) ? 1 : 0);

  const wantClip = new Set<number>();
  const wantVeo = new Set<number>();
  const phaseResults: ClipQuotaPhaseResult[] = [];
  let clipSeconds = 0;
  let veoSeconds = 0;
  let shortfallSeconds = 0;

  for (const phase of phases) {
    // Blocks whose spoken window STARTS inside this phase. Start time (not
    // overlap) so a block belongs to exactly one phase and the phases partition
    // the timeline — a block straddling the 4-minute mark counts as phase 1.
    const inPhase = (s: PlannedSegment) =>
      s.startTime >= phase.startSeconds && s.startTime < phase.endSeconds;

    const eligible: number[] = [];
    let visualSeconds = 0;
    let phaseTotalSeconds = 0;
    segs.forEach((s, i) => {
      if (!inPhase(s)) return;
      phaseTotalSeconds += dur(s);
      if (!isVisual(s)) return;
      visualSeconds += dur(s);
      if (!inCutoff(s)) return;
      eligible.push(i);
    });

    const phaseVeoFraction = veoOn ? Math.max(0, phase.veoFraction) : 0;
    const basisSeconds = basis === "visual" ? visualSeconds : phaseTotalSeconds;
    const targetVeo = basisSeconds * phaseVeoFraction;
    const targetClip = basisSeconds * (Math.max(0, phase.clipFraction) + phaseVeoFraction);

    // Fill the phase's seconds budget, spreading evenly WITHIN each preference
    // tier so the chosen clips land across the whole PHASE rather than clumping
    // at its start.
    const byTier = new Map<number, number[]>();
    for (const i of eligible) {
      const t = tierOf(i);
      if (!byTier.has(t)) byTier.set(t, []);
      byTier.get(t)!.push(i);
    }
    const order: number[] = [];
    for (const t of [3, 2, 1, 0]) {
      const tier = byTier.get(t) ?? [];
      for (const oi of spreadOrder(tier.length)) order.push(tier[oi]);
    }

    const phaseClips: number[] = [];
    let phaseClipSeconds = 0;
    for (const idx of order) {
      if (phaseClipSeconds >= targetClip) break;
      wantClip.add(idx);
      phaseClips.push(idx);
      phaseClipSeconds += dur(segs[idx]);
    }
    const phaseShortfall = Math.max(0, targetClip - phaseClipSeconds);

    // Of this phase's chosen clips, the evenly-spread prefix that fills the VEO
    // budget renders on veo; the rest on LTX. Floor of one veo block whenever
    // the lane is on for this phase and any clip exists — on a short window 10%
    // can round to less than a single block, and "10% veo" plainly means at
    // least one. A phase with veoFraction 0 (the client's opening window) gets
    // NO veo at all, floor included.
    const clipIdxInTimelineOrder = [...phaseClips].sort((a, b) => a - b);
    let phaseVeoSeconds = 0;
    let phaseVeoBlocks = 0;
    if (phaseVeoFraction > 0) {
      for (const oi of spreadOrder(clipIdxInTimelineOrder.length)) {
        if (phaseVeoSeconds >= targetVeo && phaseVeoBlocks > 0) break;
        const idx = clipIdxInTimelineOrder[oi];
        wantVeo.add(idx);
        phaseVeoBlocks++;
        phaseVeoSeconds += dur(segs[idx]);
      }
    }

    clipSeconds += phaseClipSeconds;
    veoSeconds += phaseVeoSeconds;
    shortfallSeconds += phaseShortfall;
    phaseResults.push({
      label: phase.label,
      startSeconds: phase.startSeconds,
      endSeconds: phase.endSeconds,
      basisSeconds,
      targetClipSeconds: targetClip,
      targetVeoSeconds: targetVeo,
      clipSeconds: phaseClipSeconds,
      veoSeconds: phaseVeoSeconds,
      shortfallSeconds: phaseShortfall,
      ltxBlocks: phaseClips.length - phaseVeoBlocks,
      veoBlocks: phaseVeoBlocks,
    });
  }

  const targetClipSeconds = phaseResults.reduce((a, p) => a + p.targetClipSeconds, 0);
  const targetVeoSeconds = phaseResults.reduce((a, p) => a + p.targetVeoSeconds, 0);

  let promoted = 0;
  let demoted = 0;
  const segments = segs.map((seg, i) => {
    if (seg.blockType !== "image" && seg.blockType !== "ai_clip") {
      return seg.clipEngine ? { ...seg, clipEngine: null } : seg;
    }
    if (!wantClip.has(i)) {
      // Not in the budget: this block is a still.
      if (seg.blockType === "ai_clip") {
        demoted++;
        return { ...seg, blockType: "image" as SyntheticBlockType, animationPrompt: null, clipEngine: null };
      }
      return seg.clipEngine ? { ...seg, clipEngine: null } : seg;
    }
    const clipEngine: "ltx" | "veo" = wantVeo.has(i) ? "veo" : "ltx";
    if (seg.blockType === "image") promoted++;
    return { ...seg, blockType: "ai_clip" as SyntheticBlockType, clipEngine };
  });

  return {
    segments,
    totalSeconds,
    targetClipSeconds,
    targetVeoSeconds,
    clipSeconds,
    veoSeconds,
    promoted,
    demoted,
    veoBlocks: wantVeo.size,
    ltxBlocks: wantClip.size - wantVeo.size,
    shortfallSeconds,
    phases: phaseResults,
  };
}

// Guarantee a MINIMUM number of split_2 blocks (client 2026-06-30: "why is
// split_2 not appeared?"). Gemini sometimes returns ZERO split_2, and nothing
// upstream can keep what was never produced — so when the final plan has fewer
// than `minKeep`, we PROMOTE evenly-spaced eligible 'image' blocks to split_2.
//
// A promoted split_2 is fully renderable: the avatar processor generates the
// talking-head LEFT half (from the project avatar image) and the still RIGHT
// half (from the block's existing image_prompt), so an 'image' with a usable
// prompt is a safe source. We promote only AFTER the opening clip-heavy window
// (split_2 is a presenter-beside-still explanatory layout, not an opening-action
// shot) and space the promotions evenly across eligible blocks so they don't
// clump. avatar / ai_clip / existing split_2 are never touched. Runs LAST (after
// the visual-balance pass) so balance can't flip a promotion back to image.
//
// FRONT-LOADING (client 2026-08-18: "Put 80% of the splitscreens in the first 12
// min and the 20% to the rest"). Promotions are targeted at the front zone until
// its share of the total is met, then at the tail. That instruction pulls against
// the clip-mix one — the opening window is to be mostly clips, and split_2 is not
// a clip — so `introCutoffSeconds` is the PHASE-1 clip window (3 min since
// 2026-08-20, was 4), not the old 15-minute clip-heavy cutoff: promotions start
// once the clip-heavy opening ends, which leaves 3-12 min to carry the bulk of
// the front share.
export function ensureMinSplit2(
  segs: PlannedSegment[],
  minKeep: number,
  introCutoffSeconds: number,
  // Front zone for the client's 80/20 placement split. 0 disables zoning, in
  // which case this behaves exactly as it did before (spread over everything
  // past the intro cutoff).
  frontSeconds: number = 0,
  frontShare: number = 0,
): { segments: PlannedSegment[]; promoted: number; promotedFront: number } {
  if (minKeep <= 0) return { segments: segs, promoted: 0, promotedFront: 0 };
  const have = segs.filter((s) => s.blockType === "split_2").length;
  const need = minKeep - have;
  if (need <= 0) return { segments: segs, promoted: 0, promotedFront: 0 };

  const zoned = frontSeconds > 0 && frontShare > 0;
  // Eligible: a plain 'image' AFTER the intro cutoff with a non-empty prompt.
  const eligibleIdx: number[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (
      s.blockType === "image" &&
      s.startTime >= introCutoffSeconds &&
      (s.imagePrompt ?? "").trim().length > 0
    ) {
      eligibleIdx.push(i);
    }
  }
  if (eligibleIdx.length === 0) return { segments: segs, promoted: 0, promotedFront: 0 };

  // How many of the FINAL split_2 set should sit in the front zone, and how many
  // already do. Promotions are steered to close that gap first; whatever is left
  // over is spread across the tail. Measured against minKeep (the target total),
  // not against `need`, so an existing front cluster correctly reduces the front
  // promotions rather than doubling up on them.
  const inFront = (i: number) => segs[i].startTime < frontSeconds;
  const frontTarget = zoned ? Math.round(minKeep * frontShare) : 0;
  const frontHave = zoned
    ? segs.filter((s) => s.blockType === "split_2" && s.startTime < frontSeconds).length
    : 0;
  let frontWanted = zoned ? Math.max(0, frontTarget - frontHave) : 0;

  // Where do EXISTING split_2 already sit? Gemini routinely CLUMPS them at the
  // start or end of a video, so an even-stride pass that ignores them would pile
  // promotions on top of the existing cluster and leave the middle empty (client:
  // "split_2 should appear in the WHOLE video, not only the start or end part").
  // Instead, greedily promote the eligible image that is FARTHEST from every
  // already-split_2 block (and from every promotion so far) — a farthest-point
  // fill that spreads the COMBINED set across the whole timeline regardless of
  // where Gemini clustered. Distance is measured in block positions.
  const anchors: number[] = [];
  for (let i = 0; i < segs.length; i++) if (segs[i].blockType === "split_2") anchors.push(i);
  const take = Math.min(need, eligibleIdx.length);
  const chosen = new Set<number>();
  let promotedFront = 0;

  // One greedy farthest-point pick from `pool`. Returns the chosen index, or -1
  // when the pool is exhausted. Spreading is measured against ALL anchors (both
  // zones) so a front-zone pick still avoids landing on top of a tail cluster.
  const pickFarthest = (pool: number[]): number => {
    let bestIdx = -1;
    let bestDist = -1;
    for (const idx of pool) {
      if (chosen.has(idx)) continue;
      // Distance to the nearest anchor (existing or already-chosen split_2).
      let nearest = Infinity;
      for (const a of anchors) nearest = Math.min(nearest, Math.abs(idx - a));
      if (nearest > bestDist) {
        bestDist = nearest;
        bestIdx = idx;
      }
    }
    if (bestIdx < 0) return -1;
    chosen.add(bestIdx);
    anchors.push(bestIdx);
    if (zoned && inFront(bestIdx)) promotedFront++;
    return bestIdx;
  };

  // FRONT ZONE FIRST — fill the client's 80% share out of the front-window
  // eligibles before touching the tail. Runs before the seeding below so a plan
  // with no existing split_2 still front-loads instead of seeding at the
  // timeline midpoint.
  if (zoned && frontWanted > 0) {
    const frontPool = eligibleIdx.filter(inFront);
    while (frontWanted > 0 && chosen.size < take) {
      if (pickFarthest(frontPool) < 0) break; // front window is out of eligibles
      frontWanted--;
    }
  }

  // If Gemini produced NO split_2 at all, seed with the eligible midpoint so the
  // first pick isn't pinned to an edge, then let the farthest-point fill spread
  // the rest around it.
  if (anchors.length === 0 && take > 0) {
    const mid = eligibleIdx[Math.floor(eligibleIdx.length / 2)];
    chosen.add(mid);
    anchors.push(mid);
    if (zoned && inFront(mid)) promotedFront++;
  }
  // Remaining promotions spread across everything eligible. When the front zone
  // ran out of eligibles above, this is also what spills its unfilled share into
  // the tail rather than shipping fewer split_2 than the band calls for.
  while (chosen.size < take) {
    if (pickFarthest(eligibleIdx) < 0) break;
  }

  let promoted = 0;
  const out = segs.map((s, i) => {
    if (!chosen.has(i)) return s;
    promoted++;
    // image -> split_2: keep script + image_prompt (becomes the right-half
    // still); a split_2 has no motion, so drop any animationPrompt.
    return { ...s, blockType: "split_2" as SyntheticBlockType, animationPrompt: null };
  });
  return { segments: out, promoted, promotedFront };
}

/**
 * MOVE split_2 into the front window without changing how many there are
 * (client 2026-08-18: "Put 80% of the splitscreens in the first 12 min and the
 * 20% to the rest").
 *
 * Why this exists as a third pass. The cap pass front-loads only what Gemini
 * ALREADY put in the front window, and the floor pass only promotes when the
 * total is below the band floor. So a plan that is comfortably inside the band
 * but whose split_2 all sit past 12 minutes satisfies both passes and still
 * misses the client's placement rule entirely — the common case, since Gemini
 * clusters split_2 wherever the script turns explanatory.
 *
 * This closes that gap by TRADING: promote an eligible 'image' inside the front
 * window and demote a split_2 from the tail, one for one, until the front share
 * is met or it runs out of either side. Total split_2 count is unchanged, so the
 * band the client tuned separately still holds exactly.
 *
 * Tail blocks are given up CLOSEST-PAIR FIRST — thinning a tail clump both
 * serves the trade and improves tail spacing, whereas taking them in timeline
 * order would strip the tail from one end and leave a gap.
 */
export function rebalanceSplit2ToFront(
  segs: PlannedSegment[],
  opts: {
    frontSeconds: number;
    frontShare: number;
    // Blocks before this are off-limits for promotion (the clip-heavy opening).
    introCutoffSeconds: number;
    minGap: number;
    // Spacing between two split_2 both inside the front window. Unset falls
    // back to minGap. See SYNTHETIC_SPLIT2_FRONT_MIN_GAP.
    frontMinGap?: number;
  },
): { segments: PlannedSegment[]; moved: number; frontBefore: number; frontAfter: number; total: number } {
  const total = segs.filter((s) => s.blockType === "split_2").length;
  const inFront = (i: number) => segs[i].startTime < opts.frontSeconds;
  const frontBefore = segs.filter(
    (s) => s.blockType === "split_2" && s.startTime < opts.frontSeconds,
  ).length;
  const noop = { segments: segs, moved: 0, frontBefore, frontAfter: frontBefore, total };
  if (total === 0 || opts.frontSeconds <= 0 || opts.frontShare <= 0) return noop;

  const want = Math.round(total * opts.frontShare) - frontBefore;
  if (want <= 0) return noop;

  // Tail split_2, ordered by how tightly packed each is against its tail
  // neighbours — the tightest goes first.
  const tailIdx: number[] = [];
  segs.forEach((s, i) => { if (s.blockType === "split_2" && !inFront(i)) tailIdx.push(i); });
  const nearestTailNeighbour = (i: number) => {
    let best = Infinity;
    for (const k of tailIdx) if (k !== i) best = Math.min(best, Math.abs(k - i));
    return best;
  };
  const giveUp = [...tailIdx].sort(
    (a, b) => nearestTailNeighbour(a) - nearestTailNeighbour(b) || b - a,
  );

  // Front-window images we may promote. Same eligibility as the floor pass: a
  // plain image, past the clip-heavy opening, with a prompt to render.
  const frontPool: number[] = [];
  segs.forEach((s, i) => {
    if (
      s.blockType === "image" &&
      inFront(i) &&
      s.startTime >= opts.introCutoffSeconds &&
      (s.imagePrompt ?? "").trim().length > 0
    ) {
      frontPool.push(i);
    }
  });

  const moves = Math.min(want, giveUp.length, frontPool.length);
  if (moves <= 0) return noop;

  // Spread the promotions across the front window, away from split_2 already
  // there — same farthest-point fill the floor pass uses.
  const anchors: number[] = [];
  segs.forEach((s, i) => { if (s.blockType === "split_2") anchors.push(i); });
  // A promotion lands in the front window, so its spacing against another front
  // split_2 uses the front rule; against a tail one, the wider rule.
  const gapFront = opts.frontMinGap != null && opts.frontMinGap >= 0 ? opts.frontMinGap : opts.minGap;
  const promote = new Set<number>();
  while (promote.size < moves) {
    let bestIdx = -1;
    let bestDist = -1;
    for (const idx of frontPool) {
      if (promote.has(idx)) continue;
      // Honour the spacing rule the client asked for — a promotion that lands
      // next to an existing split_2 recreates the back-to-back pairs they
      // rejected, so skip it rather than take the trade.
      let nearest = Infinity;
      let blocked = false;
      for (const a of anchors) {
        const d = Math.abs(idx - a);
        nearest = Math.min(nearest, d);
        const limit = inFront(a) ? gapFront : opts.minGap;
        if (limit > 0 && d <= limit) { blocked = true; break; }
      }
      if (blocked) continue;
      if (nearest > bestDist) { bestDist = nearest; bestIdx = idx; }
    }
    if (bestIdx < 0) break;
    promote.add(bestIdx);
    anchors.push(bestIdx);
  }
  if (promote.size === 0) return noop;

  // Demote exactly as many as we promoted, so the total never moves.
  const demote = new Set(giveUp.slice(0, promote.size));

  const out = segs.map((s, i) => {
    if (promote.has(i)) {
      return { ...s, blockType: "split_2" as SyntheticBlockType, animationPrompt: null };
    }
    if (demote.has(i)) {
      return { ...s, blockType: "image" as SyntheticBlockType, animationPrompt: null };
    }
    return s;
  });
  return {
    segments: out,
    moved: promote.size,
    frontBefore,
    frontAfter: frontBefore + promote.size,
    total,
  };
}

// Coalesce CONTIGUOUS avatar segments into one atomic avatar "part".
//
// The audio-driven HeyGen flow treats one Google-Doc avatar passage as a SINGLE
// unit: one sliced audio window -> one HeyGen render (lip-synced to that audio)
// -> one timeline block. But the planner upstream emits avatar narration as
// several small rows (Gemini's ~6s block sizing, plus splitByMarks carving a
// marked range that straddles multiple Gemini blocks). Left as-is, a 35s avatar
// passage would become ~6 separate HeyGen renders driven by text — exactly the
// duration-mismatch problem we're removing.
//
// So after avatar-marking we merge any run of back-to-back avatar segments into
// one: concatenate the scripts (space-joined), take the first segment's start
// and the last segment's end, and recompute the duration from that window. The
// merged row's spoken window [startTime, endTime) is what the avatar processor
// slices out of master_voiceover.mp3 and uploads to HeyGen.
//
// Non-avatar segments pass through untouched. We LOG a warning if a merged part
// ever exceeds AVATAR_PART_MAX_SECONDS rather than splitting, since by agreement
// it never should — the log surfaces a content-rule violation instead of
// silently producing an over-length HeyGen request.
export function coalesceAvatarSegments(segs: PlannedSegment[]): {
  segments: PlannedSegment[];
  merged: number;
  overLengthParts: number;
} {
  const out: PlannedSegment[] = [];
  let merged = 0;
  let overLengthParts = 0;
  for (const seg of segs) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.blockType === "avatar" &&
      seg.blockType === "avatar" &&
      // Only coalesce parts of the SAME model — an Avatar IV (red) part and an
      // Avatar III (orange) part must each render on their own model, so they
      // stay separate HeyGen renders even when contiguous.
      (prev.avatarModel ?? "avatar_iv") === (seg.avatarModel ?? "avatar_iv")
    ) {
      // Extend the open avatar part to include this segment.
      prev.script = `${prev.script} ${seg.script}`.replace(/\s+/g, " ").trim();
      prev.endTime = seg.endTime;
      prev.duration = Math.max(0.5, prev.endTime - prev.startTime);
      merged++;
      if (prev.duration > AVATAR_PART_MAX_SECONDS) overLengthParts++;
      continue;
    }
    // Start a new part (clone so we never mutate the caller's array entries).
    out.push({ ...seg });
    if (seg.blockType === "avatar" && seg.duration > AVATAR_PART_MAX_SECONDS) {
      overLengthParts++;
    }
  }
  return { segments: out, merged, overLengthParts };
}

// Cover a long VISUAL sentence with TWO visuals instead of one — WITHOUT
// cutting the sentence's script. (Client direction 2026-06.)
//
// The old behaviour sliced a long block's SCRIPT into fragments and made each
// fragment its own block. That degraded quality: every visual was then
// generated from a partial clause ("standing out there in flip-flops…") that
// Gemini reasoned about out of context, so the image/clip no longer reflected
// the whole thought. Instead we now keep ONE sentence = ONE thought: every
// sub-block carries the FULL sentence's script and its FULL-sentence prompt, so
// the visual is always generated with complete context. We split only the
// on-screen TIME, attaching a second visual to fill a long sentence so it isn't
// a static hold.
//
// Rules (per client):
//   - A sentence <= threshold (~6-8s): ONE visual, unchanged.
//   - A sentence > threshold: N EVEN slots of ~target seconds each
//     (N = round(duration / target), at least 2) — a single midpoint split left
//     a very long sentence as two halves that could STILL exceed the threshold
//     (a 26s sentence -> two 13s blocks, over the ~5-6s pacing rule and outside
//     LTX's single-generation range).
//       * ai_clip sentence  -> CLIP first (snapped to LTX's tier), then IMAGES
//         fill the remaining slots (different scenes/angles of the SAME
//         sentence). So slot 1 stays ai_clip; slots 2+ become `image`.
//       * image sentence    -> IMAGE per slot, each a different scene/angle of
//         the SAME sentence.
//       * split_2 sentence  -> left to the avatar flow (a talking presenter
//         holds the whole sentence); not time-split here.
//
// Every slot keeps the parent's FULL script. Slot 2 shows a DIFFERENT scene: it
// uses Gemini's distinct imagePrompt2 when present (a genuinely different
// subject/moment of the same sentence), and only falls back to the secondVisual
// "different angle" nudge on imagePrompt when imagePrompt2 is absent. Slots 3+
// are flagged secondVisual so the planner's distinct-scene pass regenerates a
// genuinely different composition for each (avoiding the earlier slots' scenes)
// — so no two slots render as duplicate frames.
//
// 'avatar' / 'split_2' blocks are NEVER time-split: the talking head holds for
// the whole sentence and is generated by HeyGen. `position` is reassigned by
// the caller after all splits.
export function splitByDuration(
  seg: PlannedSegment,
  targetSeconds: number,
  thresholdSeconds: number,
): PlannedSegment[] {
  if (seg.blockType === "avatar" || seg.blockType === "split_2") return [seg];
  const dur = seg.endTime - seg.startTime;
  if (dur <= thresholdSeconds || dur <= 0) return [seg];

  // N even slots of ~target seconds each, so every slot lands back inside the
  // pacing window regardless of how long the sentence runs (26s -> 4 slots of
  // 6.5s, not two 13s halves).
  const slots = Math.max(2, Math.round(dur / targetSeconds));

  // The second visual prefers Gemini's distinct imagePrompt2 (a genuinely
  // different scene of the same sentence). When present we swap it into the
  // second piece's imagePrompt and DON'T set secondVisual — no weak "different
  // angle" suffix is needed because the scene is already different. Only when
  // imagePrompt2 is missing do we fall back to flagging secondVisual so persist
  // appends the variation nudge to the (reused) first prompt.
  // imagePrompt2 is only worth taking if it is genuinely a DIFFERENT picture.
  //
  // Measured 2026-08-26 on a live post-deploy plan: blocks #202/#203, #304/#305
  // and #407/#408 held BYTE-IDENTICAL prompts -- the same shot rendered twice in
  // a row. Gemini had returned imagePrompt2 equal to imagePrompt, and this
  // branch trusted it because it was non-empty. The planner prompt asks for "a
  // SECOND, genuinely DIFFERENT picture"; nothing checked that it got one.
  //
  // When it is missing OR too close to the first, fall through to
  // secondVisual: true, which is the path that already exists for exactly this
  // case -- persist adds the different-angle nudge and the distinct-scene pass
  // regenerates it against the first.
  const applySecondScene = (piece: PlannedSegment): PlannedSegment => {
    const first = (seg.imagePrompt ?? "").trim();
    const second = (seg.imagePrompt2 ?? "").trim();
    const distinct = second.length > 0 && sceneSimilarity(sceneWords(second), sceneWords(first)) < 0.85;
    return distinct
      ? { ...piece, imagePrompt: second, shotType: seg.shotType2 ?? seg.shotType, secondVisual: false }
      : { ...piece, secondVisual: true };
  };

  const pieces: PlannedSegment[] = [];
  for (let k = 0; k < slots; k++) {
    const startTime = seg.startTime + (k * dur) / slots;
    const endTime = seg.startTime + ((k + 1) * dur) / slots;
    let piece: PlannedSegment = {
      ...seg,
      startTime,
      endTime,
      duration: Math.max(0.5, endTime - startTime),
    };
    if (k > 0 && seg.blockType === "ai_clip") {
      // Clip first (it snaps to an LTX tier at generation time), images fill
      // the remainder. Only the clip slot carries motion — a still has none.
      piece.blockType = "image";
      piece.animationPrompt = null;
    }
    // Slot k takes the k-th scene the planner wrote for this sentence:
    //   k = 0  -> imagePrompt
    //   k = 1  -> imagePrompt2      (via applySecondScene, which rejects a
    //                                near-clone of imagePrompt)
    //   k >= 2 -> extraScenes[k - 2]
    // Each is a DIFFERENT concrete thing the sentence names, so a long
    // sentence cuts on its own phrases the way the client's reference video
    // does, instead of holding one subject for 14 seconds.
    if (k === 1) piece = applySecondScene(piece);
    else if (k > 1) {
      const extra = seg.extraScenes?.[k - 2];
      const text = (extra?.imagePrompt ?? "").trim();
      // Guard the same way applySecondScene does: a model that echoes an
      // earlier slot's wording would put us straight back to duplicate frames,
      // and the secondVisual path already exists to regenerate those.
      const prior = [seg.imagePrompt ?? "", seg.imagePrompt2 ?? "", ...(seg.extraScenes ?? []).slice(0, k - 2).map((e) => e.imagePrompt)]
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const distinct =
        text.length > 0 &&
        prior.every((p) => sceneSimilarity(sceneWords(text), sceneWords(p)) < 0.85);
      piece = distinct
        ? { ...piece, imagePrompt: text, shotType: extra?.shotType || seg.shotType, secondVisual: false }
        : { ...piece, secondVisual: true };
    }
    pieces.push(piece);
  }
  return pieces;
}

// Set a segment's avatar-ness. Marked -> avatar (drop visual prompts).
// Unmarked -> if it was avatar (Gemini's choice, not a real mark), demote to
// image; otherwise keep whatever non-avatar type it already had.
//
// `basePrompt` is the video's shared style bible. A demoted avatar block carried
// NO imagePrompt from Gemini (avatar blocks get none), so without a fallback its
// prompt would be empty. We fall back to the basePrompt — a real, on-style
// visual of the video's recurring world — instead of the raw narration sentence,
// which makes a poor, over-literal generation prompt.
function applyMark(
  seg: PlannedSegment,
  marked: boolean,
  basePrompt: string,
  model: AvatarModel | null = null,
): PlannedSegment {
  if (marked) {
    // Doc marks are authoritative, so the model comes from the highlight color.
    // Fall back to Avatar IV if a mark somehow arrived without a model (it
    // shouldn't — every range carries one).
    return {
      ...seg,
      blockType: "avatar",
      imagePrompt: null,
      animationPrompt: null,
      avatarModel: model ?? "avatar_iv",
    };
  }
  if (seg.blockType === "avatar") {
    return {
      ...seg,
      blockType: "image",
      imagePrompt: seg.imagePrompt || basePrompt.trim() || seg.script.slice(0, 200),
      avatarModel: null,
    };
  }
  return seg;
}

// Cap the number of split_2 blocks (client feedback 2026-06: "too many split_2
// parts"). Gemini chooses split_2 freely and overuses it (a 115-block plan came
// back 50 split_2). split_2 is a presenter-beside-still LAYOUT, not a content
// type, so an over-chosen one is safely DEMOTED to a plain 'image' covering the
// same sentence — its imagePrompt already describes a single-subject still (the
// illustrative half), which is exactly what an image block needs.
//
// Policy: keep at most `maxFraction` of total blocks as split_2 (at least 1 when
// any exist and the fraction is > 0), KEEPING the earliest in timeline order and
// demoting the rest. Earliest-kept gives an even early sprinkle rather than a
// late clump. `minGap` additionally requires at least that many blocks between
// two kept split_2 (client 2026-07: a step-by-step walkthrough section survived
// the count cap as 15+ CONSECUTIVE split_2 — an in-budget clump; the spacing
// rule breaks it up by demoting the in-between ones). A demoted block keeps its
// script + imagePrompt and just changes type (animationPrompt stays null —
// image has no motion). Mutates nothing; returns a new array. position is
// reassigned by the caller if needed.
export function capSplit2Blocks(
  segs: PlannedSegment[],
  maxFraction: number,
  minKeep: number = 0,
  minGap: number = 0,
  // FRONT-LOADING (client 2026-08-18: "Put 80% of the splitscreens in the first
  // 12 min and the 20% to the rest"). The allowance is divided into a front zone
  // (blocks starting before frontSeconds) and the tail; each zone keeps its own
  // quota, so the cap no longer just thins split_2 uniformly across the video.
  // frontSeconds 0 disables zoning (single whole-video quota).
  frontSeconds: number = 0,
  frontShare: number = 0,
  // Spacing rule between two split_2 that are BOTH in the front window.
  // Concentrating the client's 80% into 12 minutes is a higher density than
  // minGap was tuned for, so the front zone gets its own (tighter) rule; a
  // negative or unset value falls back to minGap. See
  // SYNTHETIC_SPLIT2_FRONT_MIN_GAP.
  frontMinGap: number = -1,
): { segments: PlannedSegment[]; demoted: number; keptFront: number; keptRest: number } {
  const zoned = frontSeconds > 0 && frontShare > 0;
  if (maxFraction >= 1 && minGap <= 0 && !zoned) {
    return { segments: segs, demoted: 0, keptFront: 0, keptRest: 0 };
  }
  const split2Idx: number[] = [];
  segs.forEach((s, i) => { if (s.blockType === "split_2") split2Idx.push(i); });
  const split2Count = split2Idx.length;
  if (split2Count === 0) return { segments: segs, demoted: 0, keptFront: 0, keptRest: 0 };
  // Allowed count: floor(total * fraction), floored at minKeep (client: ensure a
  // few split_2 survive so the layout still appears) but never above what Gemini
  // actually produced, and at least 1 when the fraction is non-zero. When the
  // fraction is 0 we still honor minKeep so an explicit floor wins over the cap.
  const fracAllowed = maxFraction <= 0 ? 0 : Math.max(1, Math.floor(segs.length * maxFraction));
  const allowed = maxFraction >= 1 ? split2Count : Math.min(split2Count, Math.max(fracAllowed, minKeep));
  if (split2Count <= allowed && minGap <= 0 && !zoned) {
    return { segments: segs, demoted: 0, keptFront: 0, keptRest: 0 };
  }

  const isFront = (i: number) => zoned && segs[i].startTime < frontSeconds;
  // Per-zone quotas. Rounding goes to the FRONT (the zone the client asked to
  // fill) so an allowance of 5 at 80% is 4 front / 1 rest, not 4/1 by luck of
  // the rounding mode.
  const quotaFront = zoned ? Math.min(allowed, Math.round(allowed * frontShare)) : allowed;
  const quotaRest = allowed - quotaFront;

  // Spacing is measured in block positions, so "minGap 5" means at least 5
  // blocks (of any type) between two kept split_2. Checked against the whole
  // kept set rather than a running "last kept" cursor, because the spill pass
  // below revisits earlier indices and a cursor would miss a backward conflict.
  //
  // A pair inside the front window uses the tighter front rule; any pair that
  // straddles the boundary falls back to the wider one, so the tail never
  // inherits front density.
  const gapFront = zoned && frontMinGap >= 0 ? frontMinGap : minGap;
  const kept = new Set<number>();
  const gapOk = (idx: number) => {
    if (minGap <= 0 && gapFront <= 0) return true;
    for (const k of kept) {
      const limit = isFront(idx) && isFront(k) ? gapFront : minGap;
      if (limit > 0 && Math.abs(idx - k) <= limit) return false;
    }
    return true;
  };

  // Pass 1 — fill each zone against its own quota, in timeline order.
  let keptFront = 0;
  let keptRest = 0;
  for (const i of split2Idx) {
    const front = isFront(i);
    const quota = front ? quotaFront : quotaRest;
    const have = front ? keptFront : keptRest;
    if (have >= quota || !gapOk(i)) continue;
    kept.add(i);
    if (front) keptFront++; else keptRest++;
  }

  // Pass 2 — SPILL. A zone that had fewer split_2 than its quota (Gemini put
  // none in the first 12 minutes, say) leaves allowance unused; rather than
  // silently shipping fewer split_2 than the band calls for, hand the remainder
  // to the other zone. Front-loading is a preference about placement, not a
  // reason to lose blocks the client's band already approved.
  if (kept.size < allowed) {
    for (const i of split2Idx) {
      if (kept.size >= allowed) break;
      if (kept.has(i) || !gapOk(i)) continue;
      kept.add(i);
      if (isFront(i)) keptFront++; else keptRest++;
    }
  }

  let demoted = 0;
  const out = segs.map((s, i) => {
    if (s.blockType !== "split_2") return s;
    if (kept.has(i)) return s;
    demoted++;
    // Demote to a single-subject still. imagePrompt/shotType already describe the
    // illustrative half — reuse them verbatim. No motion on an image.
    return { ...s, blockType: "image" as SyntheticBlockType, animationPrompt: null };
  });
  return { segments: out, demoted, keptFront, keptRest };
}

// Char index just past the FIRST sentence terminator (. ? !, optionally followed
// by a closing quote/bracket) that sits at a word boundary. -1 when the text has
// no internal sentence boundary (single sentence, or terminator only at the end).
export function firstSentenceEnd(text: string): number {
  const m = /[.?!]["')\]]?(?=\s)/.exec(text.trimEnd());
  return m ? m.index + m[0].length : -1;
}

// Cap the DURATION of a single split_2 block (client 2026-07-03: a 38s split_2).
// Gemini may lump several sentences into one split_2 block ("a few short,
// tightly-related sentences" is allowed) and split_2 is exempt from EVERY carve
// pass (the presenter half is an atomic HeyGen render), so nothing stops the
// same still from holding beside the presenter for 30s+.
//
// Policy: a split_2 longer than `maxSeconds` keeps its FIRST sentence as the
// split_2 (the layout still appears where Gemini chose it) and the remaining
// sentences become ONE plain 'image' block — which the later duration-split
// pass carves into normal ~target-second visuals like any other long image.
// Script is cut on the first sentence boundary; time is sliced proportionally
// by char count (same technique as splitByMarks). When there is no internal
// sentence boundary, or the first sentence ALONE exceeds the cap, the whole
// block is demoted to 'image' instead (nothing to carve on).
//
// Both carved pieces keep the parent's imagePrompt (which described the WHOLE
// passage) — the caller regenerates each piece's prompt for its own script via
// the returned `regen` list (non-fatal on failure, like the merge pass).
// Returns a new array; `position` is reassigned by the caller.
export function capSplit2Duration(
  segs: PlannedSegment[],
  maxSeconds: number,
): { segments: PlannedSegment[]; carved: number; demoted: number; regen: PlannedSegment[] } {
  const out: PlannedSegment[] = [];
  const regen: PlannedSegment[] = [];
  let carved = 0;
  let demoted = 0;
  if (maxSeconds <= 0) return { segments: segs, carved, demoted, regen };
  for (const seg of segs) {
    const dur = seg.endTime - seg.startTime;
    if (seg.blockType !== "split_2" || dur <= maxSeconds) {
      out.push(seg);
      continue;
    }
    const cut = firstSentenceEnd(seg.script);
    const frac = cut > 0 && cut < seg.script.length ? cut / seg.script.length : 1;
    const mid = seg.startTime + frac * dur;
    if (frac >= 1 || mid - seg.startTime > maxSeconds) {
      // Single sentence, or a first sentence that alone runs over the cap:
      // demote the whole block to a still. Its imagePrompt already describes
      // the illustrative half, and the duration-split pass paces it.
      out.push({ ...seg, blockType: "image" as SyntheticBlockType, animationPrompt: null });
      demoted++;
      continue;
    }
    const head: PlannedSegment = {
      ...seg,
      script: seg.script.slice(0, cut).trim(),
      endTime: mid,
      duration: Math.max(0.5, mid - seg.startTime),
    };
    const rest: PlannedSegment = {
      ...seg,
      blockType: "image" as SyntheticBlockType,
      animationPrompt: null,
      script: seg.script.slice(cut).trim(),
      startTime: mid,
      duration: Math.max(0.5, seg.endTime - mid),
    };
    out.push(head, rest);
    regen.push(head, rest);
    carved++;
  }
  return { segments: out, carved, demoted, regen };
}

type RawSegment = z.infer<typeof GeminiSegmentSchema>;

// Salvage a segments array from a response that JSON.parse rejected because it
// was cut off mid-stream (Gemini hit its output-token cap and never closed the
// JSON). The shape is { basePrompt, segments: [ { ...flat fields... } ] }, so a
// segment object closes when we drop from brace-depth 2 -> 1 while inside the
// segments bracket (bracket-depth 1). We truncate to the last fully-closed
// segment and re-close the array + object, recovering every complete segment
// instead of losing the whole chunk. Returns null when nothing is salvageable.
function salvageTruncatedTimeline(raw: string): unknown | null {
  let depthBrace = 0;
  let depthBracket = 0;
  let lastSafeEnd = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depthBrace++;
    else if (c === "}") {
      const before = depthBrace;
      depthBrace--;
      // Just closed a segment object: was at depth 2, now 1, inside segments[].
      if (before === 2 && depthBracket === 1) lastSafeEnd = i;
    } else if (c === "[") depthBracket++;
    else if (c === "]") depthBracket--;
  }
  if (lastSafeEnd < 0) return null;
  const trimmed = raw.slice(0, lastSafeEnd + 1) + "]}";
  try { return JSON.parse(trimmed); } catch { return null; }
}

// Split a transcript into chunks of at most maxChars, breaking only at sentence
// boundaries (. ? ! followed by whitespace) so a chunk never ends mid-sentence
// — the planner's "one sentence = one block" rule depends on whole sentences,
// and a clean boundary keeps each chunk's segments aligned to real text. A
// single sentence longer than maxChars is emitted as its own (oversized) chunk
// rather than being cut, since cutting it would violate the rule anyway.
function chunkTranscriptBySentence(transcript: string, maxChars: number): string[] {
  const text = transcript.trim();
  if (text.length <= maxChars) return [text];
  // Sentence terminators with trailing space; keep the terminator with its
  // sentence. The lookbehind-free split keeps delimiters via a capturing regex.
  const parts = text.split(/(?<=[.?!])\s+/);
  const chunks: string[] = [];
  let cur = "";
  for (const sentence of parts) {
    if (!cur) {
      cur = sentence;
    } else if (cur.length + 1 + sentence.length <= maxChars) {
      cur += " " + sentence;
    } else {
      chunks.push(cur);
      cur = sentence;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const VideoTopicSchema = z.object({
  niche: optString(),
  setting: optString(),
  subjectExamples: optString(),
  environmentExamples: optString(),
});

// Derive the video's niche/world from the project title + a leading transcript
// sample, ONCE per plan. This is the fix for off-topic visuals: the planner was
// hardcoded to a gardening/lawn-care niche, so a car-maintenance script rendered
// houses and lawns. We now infer the actual subject and thread it into every
// image prompt so the visuals stay on-theme for ANY channel. A cheap Gemini call
// (thinkingBudget:0, tiny output) — on any failure we return EMPTY_TOPIC and the
// prompt falls back to niche-neutral phrasing (no regression).
// What deriveVideoTopic actually reads of the transcript.
//
// WHY NOT slice(0, 1500). It used to be the opening 1500 characters, which is
// the WORST window for the format the client sends most often: a numbered list
// ("15 foods you should never refrigerate"). The intro of such a script names
// only the framing device — the fridge — and every real subject (tomatoes,
// bread, honey, coffee, eggs) lives in the body, past the cutoff. The derived
// niche came back as "refrigerator / food storage", buildTopicBlock stamped
// that world onto all 541 blocks, and the client watched the same fridge door
// open and close for twenty minutes (feedback 2026-09-01: "it's not only about
// fridge ... the logic right now it's focusing too much on the fridge").
//
// Note this is NOT the niche-as-a-cage bug fixed on 2026-08-26 (see the
// PRECEDENCE note in buildTopicBlock). That rule lets a line override the niche
// when it names something OUTSIDE it — but a tomato is not outside a fridge
// video, it is food, so the override never fires and the model picks the most
// on-niche framing available: the tomato, at the fridge. The topic itself has
// to be right; precedence cannot rescue a topic derived from the intro alone.
//
// So: spread the same budget across the WHOLE transcript. Evenly-spaced windows
// see the enumerated items wherever they fall, and the joined sample stays small
// enough to keep this a cheap flash call.
const TOPIC_SAMPLE_TOTAL_CHARS = 4000;
const TOPIC_SAMPLE_WINDOWS = 8;
const TOPIC_SAMPLE_MAX_HEADINGS = 30;

// A list/countdown item heading, in any supported narration language:
//   "Number 15." · "Número quince." · "Nummer fünfzehn." · "#3" · "Tip 4:"
// Anchored to a sentence or line start so a bare year or quantity mid-sentence
// ("In 1950...", "15 grams") cannot masquerade as a heading. The capture keeps
// the marker plus the short text that follows it — which is the item's NAME,
// the thing the visuals actually need.
const LIST_HEADING_RE =
  /(?:^|[.\n])\s*((?:number|n[uú]mero|nummer|no\.?|#|tip|step|paso|schritt)?\s*#?\s*(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|eins|zwei|drei|vier|f[uü]nf|sechs|sieben|acht|neun|zehn|elf|zw[oö]lf)\s*[.:)\-–]\s*[^.\n]{0,80})/gi;

function listHeadings(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(LIST_HEADING_RE)) {
    const h = m[1].trim().replace(/\s+/g, " ");
    // "3." alone carries no subject; require the item's name to follow.
    if (h.length < 6) continue;
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= TOPIC_SAMPLE_MAX_HEADINGS) break;
  }
  return out;
}

export function topicSample(transcript: string): string {
  const text = transcript.trim();
  if (text.length <= TOPIC_SAMPLE_TOTAL_CHARS) return text;

  const per = Math.floor(TOPIC_SAMPLE_TOTAL_CHARS / TOPIC_SAMPLE_WINDOWS);
  // Last window starts `per` from the end, so the closing section (often where a
  // list video summarises what it covered) is always represented.
  const span = text.length - per;
  const parts: string[] = [];
  for (let i = 0; i < TOPIC_SAMPLE_WINDOWS; i++) {
    const start = Math.floor((span * i) / (TOPIC_SAMPLE_WINDOWS - 1));
    parts.push(text.slice(start, start + per).trim());
  }
  // The gaps are real and must be visible: without a marker the model reads the
  // joined windows as continuous prose and can invent a through-line across a
  // cut that does not exist in the script.
  const windows = parts.join("\n[...]\n");

  // Evenly-spaced windows alone are not enough for the format that caused this
  // bug. A 15-item list gives each item ~1500 characters, so eight windows land
  // mid-item far more often than on the heading that NAMES it — measured on a
  // fixture of the client's script, windows alone surfaced 1 of 15 items. The
  // headings are the one place every item is named in full, so pull them out
  // explicitly instead of hoping a window lands on one.
  const headings = listHeadings(text);
  if (headings.length < 3) return windows; // not a list script; windows are fine
  return [
    "LIST ITEMS (every numbered item in this video, in order):",
    ...headings.map((h) => `- ${h}`),
    "",
    "EXCERPTS:",
    windows,
  ].join("\n");
}

export async function deriveVideoTopic(input: {
  projectId: string;
  jobId?: string;
  title: string;
  transcript: string;
  language: LanguageCode;
}): Promise<VideoTopic> {
  const { projectId, jobId, title, transcript, language } = input;
  const locale = getLocale(language);
  // Every early return and failure path must PRESERVE the language — the topic
  // may be underivable, but the video is still German, and buildTopicBlock
  // reads the region off this object.
  const emptyTopic: VideoTopic = { ...EMPTY_TOPIC, language };
  const sample = topicSample(transcript);
  if (!title.trim() && !sample) return emptyTopic;
  const prompt = [
    // The title and sample below are in the narration language; the four fields
    // we get back feed image prompts, so they must come back in English — and
    // describe a place in the audience's own region.
    ...promptLanguageRule(locale),
    ...visualCultureRule(locale),
    "You are setting up the visual world for a short narrated video. From the",
    "TITLE and the transcript SAMPLE below, infer the video's subject/niche so a",
    "downstream image generator keeps every shot on-theme.",
    "",
    "Return STRICT JSON ONLY:",
    '{"niche": "...", "setting": "...", "subjectExamples": "...", "environmentExamples": "..."}',
    "- niche: short label of the topic, e.g. \"automotive / DIY car maintenance\",",
    '  "home cooking", "personal finance".',
    "- setting: the recurring physical place the creator would film in, e.g.",
    '  "home garage / driveway, under the hood", "a home kitchen".',
    "- subjectExamples: a few concrete on-topic objects/subjects, comma-separated,",
    '  e.g. "spark plugs, engine bays, hand tools, oil, dashboards".',
    "- environmentExamples: a few WIDER real-world context scenes of this niche —",
    "  the subject in use or in motion out in its environment, NOT close-ups of",
    '  the objects, comma-separated. e.g. for an engine video: "utes driving on',
    '  highways, vehicles on outback roads, a pickup pulling into a driveway";',
    '  for a cooking video: "a family dinner table, dishes being served".',
    "The examples above are ONLY to show the format — they are illustrative and",
    "MUST NOT influence your answer. Derive every field from THIS video's title",
    "and transcript. In particular, do NOT default to gardening, lawns, a garden",
    "setting, or 'home & garden' unless the transcript is literally about",
    "gardening. 'Home' means the INDOOR living space (kitchen, living room,",
    "bedroom, hallway) and its immediate porch/doorway — it is NOT a garden,",
    "backyard, lawn, or vegetable patch. Only use garden/outdoor-plant imagery",
    "when the narration is specifically about gardening or being outdoors.",
    "For a lifestyle / health / personal-story video with no single",
    "physical craft, prefer a niche/setting drawn from what the narration actually",
    "shows (e.g. a health & wellness routine filmed around a home's kitchen,",
    "living room, and neighbourhood) rather than forcing a generic backyard.",
    "",
    "REMOTE / NON-FILMABLE SUBJECTS (important): some videos are about a world that",
    "canNOT be filmed in a home, garage, kitchen, or office — e.g. space and",
    "astronomy (planets, spacecraft, deep space), the deep ocean, Antarctica / the",
    "poles, wilderness, history / ancient sites, or unexplained-mystery / cryptid",
    "topics. For these, the `setting` and `environmentExamples` MUST be the REAL",
    "subject environment itself, NOT a person's home/office/studio. A commentary or",
    "documentary-style narration ABOUT such a subject still lives in that subject's",
    "world on screen. Examples of the CORRECT world for these: for a Voyager /",
    "space video — \"deep space, planets and their moons, the spacecraft drifting",
    "past worlds, star fields, mission control\"; for an Antarctica mystery video —",
    "\"antarctic ice and open ocean, the frozen coast, the deep sea, the creature in",
    "its habitat\". Do NOT fall back to \"a man talking at a desk / on a computer /",
    "in an office\" as the setting for these subjects — an office is only correct",
    "when the video is genuinely about office/desk work.",
    // LIST / COUNTDOWN SCRIPTS (client feedback 2026-09-01). A "15 foods you
    // should never refrigerate" script names its framing device (the fridge) in
    // the title and the intro, and its ACTUAL subjects — the fifteen foods — one
    // at a time through the body. Derived from the framing device alone the
    // niche came back "refrigerator / food storage", and because every item is
    // still plausibly IN that world, buildTopicBlock's precedence escape never
    // fired and the video showed the same fridge over and over.
    "LIST / COUNTDOWN VIDEOS (important): when the narration works through an",
    "enumerated list — \"15 foods…\", \"10 mistakes…\", \"7 signs…\" — the ITEMS are",
    "the video's real subjects and the thing named in the title is usually just",
    "the FRAMING DEVICE. `subjectExamples` MUST name the actual items drawn from",
    "across the sample (for a fridge-storage list: \"tomatoes, potatoes, garlic,",
    "bread, honey, coffee beans, bananas, eggs\"), NOT the framing device and its",
    "parts (\"fridge shelves, crisper drawer\"). Naming only the framing device",
    "makes every shot in the finished video look identical, which is the exact",
    "failure this instruction exists to prevent.",
    "Likewise `environmentExamples` should cover the WIDER world the narration",
    "touches — where these things come from, who handles them, and the processes",
    "or science it describes (e.g. \"produce on a kitchen counter, a market stall,",
    "someone slicing a tomato, a researcher examining food in a lab\") — not the",
    "framing device being used over and over.",
    "Keep each field short (a phrase, not a sentence). No commentary.",
    "",
    `TITLE: ${title.trim() || "(none)"}`,
    "",
    // Windows sampled from across the whole transcript (see topicSample), joined
    // with [...] where text was skipped — say so, or the model reads the joins as
    // continuous prose.
    "TRANSCRIPT SAMPLE (excerpts from THROUGHOUT the video; [...] marks skipped",
    "text — infer the subject from ALL of them, not just the first):",
    sample || "(none)",
  ].join("\n");
  try {
    const { result: res } = await withGeminiModelFallback(
      "deriveVideoTopic",
      (model) =>
        model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2,
            maxOutputTokens: 512,
            thinkingConfig: { thinkingBudget: 0 },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        }),
      // Short PRIMARY ladder so a broad primary outage (whole model 503ing)
      // fails over to the healthy fallback fast instead of burning ~13s on a
      // dead model; a slightly fuller FALLBACK ladder tries harder on the model
      // that's actually answering. See withGeminiModelFallback's contract.
      { attempts: 2, baseMs: 800 },
      { attempts: 3, baseMs: 800 },
    );
    const parsed = VideoTopicSchema.safeParse(JSON.parse(res.response.text()));
    if (!parsed.success) return emptyTopic;
    const topic: VideoTopic = {
      niche: parsed.data.niche.trim(),
      setting: parsed.data.setting.trim(),
      subjectExamples: parsed.data.subjectExamples.trim(),
      environmentExamples: parsed.data.environmentExamples.trim(),
      language,
    };
    await logJob({ projectId, jobId }, "synthetic.plan.topic_derived", {
      niche: topic.niche,
      setting: topic.setting,
      environmentExamples: topic.environmentExamples,
    });
    return topic;
  } catch (e) {
    await logJob({ projectId, jobId }, "synthetic.plan.topic_failed", {
      err: (e as Error).message?.slice(0, 200),
    });
    return emptyTopic;
  }
}

// Run the Gemini planner for ONE transcript chunk and return its parsed
// basePrompt + raw segments. Sets thinkingBudget:0 and a generous output cap
// (the same fix proven in scoreClipsForSections): gemini-2.5-flash otherwise
// spends its whole output budget on hidden reasoning tokens and truncates the
// visible JSON. On a truncation we salvage whatever complete segments we got,
// and surface MAX_TOKENS in the error instead of the misleading "non-JSON".
export async function planTranscriptChunk(
  ctx: { projectId: string; jobId?: string },
  transcript: string,
  chunkLabel: string,
  topic: VideoTopic = EMPTY_TOPIC,
): Promise<{ basePrompt: string; segments: RawSegment[] }> {
  const { result: res, model: usedModel } = await withGeminiModelFallback(
    "buildSyntheticTimeline",
    (model) =>
      model.generateContent({
        contents: [{ role: "user", parts: [{ text: buildPrompt(transcript, topic) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.3,
          // Generous ceiling so we don't truncate from our side; finishReason
          // tells us if the model still overran. Raised from 16384 -> 32768:
          // a 14k-char chunk that segments into ~115 verbose blocks (each with
          // imagePrompt + imagePrompt2 + shotType + shotType2 + animationPrompt)
          // emitted ~62k chars of JSON and hit MAX_TOKENS at 16384, truncating
          // mid-stream (salvage recovered most, but it shouldn't truncate at
          // all). 32k tokens comfortably fits one chunk's output; gemini-2.5-
          // flash allows up to 65k. The chunker still caps INPUT size so this is
          // headroom, not a license to send the whole transcript in one call.
          maxOutputTokens: 32768,
          // gemini-2.5-flash burns its entire output budget on internal
          // reasoning before emitting any JSON, truncating the response at a
          // few hundred bytes regardless of the cap (see scoreClipsForSections).
          // We don't need chain-of-thought to segment a transcript.
          thinkingConfig: { thinkingBudget: 0 },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    // Short PRIMARY ladder: when gemini-flash-latest is in a broad outage the
    // old { attempts: 6, baseMs: 2000 } ladder waited 2→6→18→54→162→486s
    // (+jitter) ≈ up to ~12 min on the DEAD primary before even reaching the
    // healthy fallback — and repeated it per chunk (the 2026-07 planner
    // slowdown). Fail over fast, then try harder on the model that's answering.
    { attempts: 2, baseMs: 1500 },
    { attempts: 5, baseMs: 1500 },
  );
  if (usedModel !== getEnv().GEMINI_MODEL) {
    await logJob(ctx, "synthetic.plan.model_fallback", { model: usedModel, chunk: chunkLabel });
  }
  const txt = res.response.text();
  const finishReason = res.response.candidates?.[0]?.finishReason;

  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    const salvaged = salvageTruncatedTimeline(txt);
    if (salvaged) {
      await logJob(ctx, "synthetic.plan.salvaged_truncated", {
        chunk: chunkLabel,
        finishReason,
        responseChars: txt.length,
      });
      parsed = salvaged;
    } else {
      throw new Error(
        `buildSyntheticTimeline: Gemini response unparseable (finishReason=${finishReason}, chars=${txt.length}, chunk=${chunkLabel}): ${txt.slice(0, 200)}`,
      );
    }
  }
  const safe = GeminiResponseSchema.safeParse(parsed);
  if (!safe.success || safe.data.segments.length === 0) {
    throw new Error(
      `buildSyntheticTimeline: schema/empty (finishReason=${finishReason}, chunk=${chunkLabel}): ${JSON.stringify(safe.success ? "empty" : safe.error.flatten()).slice(0, 300)}`,
    );
  }
  return { basePrompt: safe.data.basePrompt.trim(), segments: safe.data.segments };
}

type SentenceBlock = z.infer<typeof SentenceBlockSchema>;

// Align-first counterpart of planTranscriptChunk: same model config, same
// truncation salvage, but the response is index ranges over already-timed
// sentences. The returned ranges are NOT trusted as a partition — the caller
// repairs them (repairCoverage) before they can influence anything.
async function planSentenceChunk(
  ctx: { projectId: string; jobId?: string },
  sentences: TimedSentence[],
  from: number,
  to: number,
  chunkLabel: string,
  topic: VideoTopic = EMPTY_TOPIC,
): Promise<{ basePrompt: string; blocks: SentenceBlock[] }> {
  const { result: res, model: usedModel } = await withGeminiModelFallback(
    "buildSyntheticTimeline",
    (model) =>
      model.generateContent({
        contents: [
          { role: "user", parts: [{ text: buildSentencePrompt(sentences, from, to, topic) }] },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.3,
          maxOutputTokens: 32768,
          thinkingConfig: { thinkingBudget: 0 },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    { attempts: 2, baseMs: 1500 },
    { attempts: 5, baseMs: 1500 },
  );
  if (usedModel !== getEnv().GEMINI_MODEL) {
    await logJob(ctx, "synthetic.plan.model_fallback", { model: usedModel, chunk: chunkLabel });
  }
  const txt = res.response.text();
  const finishReason = res.response.candidates?.[0]?.finishReason;

  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    const salvaged = salvageTruncatedTimeline(txt);
    if (salvaged) {
      await logJob(ctx, "synthetic.plan.salvaged_truncated", {
        chunk: chunkLabel,
        finishReason,
        responseChars: txt.length,
        path: "align_first",
      });
      parsed = salvaged;
    } else {
      throw new Error(
        `buildSyntheticTimeline: Gemini response unparseable (finishReason=${finishReason}, chars=${txt.length}, chunk=${chunkLabel}): ${txt.slice(0, 200)}`,
      );
    }
  }
  const safe = SentenceResponseSchema.safeParse(parsed);
  if (!safe.success || safe.data.segments.length === 0) {
    throw new Error(
      `buildSyntheticTimeline: schema/empty (finishReason=${finishReason}, chunk=${chunkLabel}): ${JSON.stringify(safe.success ? "empty" : safe.error.flatten()).slice(0, 300)}`,
    );
  }
  return { basePrompt: safe.data.basePrompt.trim(), blocks: safe.data.segments };
}

// Turn repaired sentence ranges into PlannedSegments. Every field that used to
// be guessed is now read off the sentence list:
//   startTime / endTime — the first and last sentence's spoken window
//   script              — the exact transcript slice those sentences span
//   charStart / charEnd — their real offsets, for exact doc-mark intersection
//
// Because the sentence windows are continuous and span exactly the voiceover
// (see buildTimedSentences), the blocks are too — so the timeline sums to the
// voiceover by construction, with no floor and no residual.
function segmentsFromSentenceBlocks(
  blocks: SentenceBlock[],
  sentences: TimedSentence[],
  transcript: string,
): PlannedSegment[] {
  const out: PlannedSegment[] = [];
  for (const b of blocks) {
    const first = sentences[b.startSentence];
    const last = sentences[b.endSentence];
    if (!first || !last) continue;
    const isVisual = b.blockType !== "avatar";
    const script = transcript.slice(first.charStart, last.charEnd).trim();
    out.push({
      position: out.length,
      blockType: b.blockType,
      startTime: first.voStart,
      endTime: last.voEnd,
      duration: Math.max(0, last.voEnd - first.voStart),
      script,
      charStart: first.charStart,
      charEnd: last.charEnd,
      imagePrompt: isVisual ? (b.imagePrompt?.trim() || null) : null,
      shotType: isVisual ? (b.shotType?.trim() || null) : null,
      imagePrompt2: isVisual ? (b.imagePrompt2?.trim() || null) : null,
      shotType2: isVisual ? (b.shotType2?.trim() || null) : null,
      // See the note on the legacy path above: per-slot scenes for slots 3+.
      extraScenes: isVisual
        ? (b.extraScenes ?? [])
            .map((e) => ({ imagePrompt: (e.imagePrompt ?? "").trim(), shotType: (e.shotType ?? "").trim() }))
            .filter((e) => e.imagePrompt.length > 0)
        : [],
      animationPrompt: b.blockType === "ai_clip" ? (b.animationPrompt?.trim() || null) : null,
    });
  }
  return out;
}

// Split the sentence list into index ranges small enough that one Gemini call
// can answer without overrunning its output budget. Mirrors
// chunkTranscriptBySentence's char budget, but boundaries are sentence indices
// so a chunk can never end mid-sentence.
function chunkSentenceRanges(
  sentences: TimedSentence[],
  maxChars: number,
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let from = 0;
  let chars = 0;
  for (let i = 0; i < sentences.length; i++) {
    const len = sentences[i].text.length + 1;
    if (chars > 0 && chars + len > maxChars) {
      ranges.push({ from, to: i - 1 });
      from = i;
      chars = 0;
    }
    chars += len;
  }
  if (from < sentences.length) ranges.push({ from, to: sentences.length - 1 });
  return ranges;
}

/**
 * Run the Gemini planner and persist the result as synthetic_segments rows.
 * Returns the planned segments. Idempotent on retry: existing segments for the
 * project are cleared before reinsert so a re-planned project doesn't duplicate.
 */
export async function buildSyntheticTimeline(input: {
  projectId: string;
  jobId?: string;
  // Project title — used (with a transcript sample) to derive the video's niche
  // so every image prompt stays on-theme. Optional/empty is fine: the planner
  // then falls back to niche-neutral phrasing.
  projectTitle?: string;
  transcript: string;
  words: WordTiming[] | null;
  voiceoverDuration: number;
  // Char-ranges in `transcript` that were red/orange in the source Google Doc.
  // Any planned segment overlapping one of these is FORCED to block_type
  // 'avatar', overriding Gemini's choice. Empty when no doc marks (pasted text).
  avatarRanges?: AvatarMarkRange[];
  // Narration language (projects.language). Decides three things: that the
  // sentence splitter applies this language's false-break rules, that Gemini
  // answers in English while reading a foreign script, and that the generated
  // world is set in the audience's own region. Defaults to English.
  language?: LanguageCode;
}): Promise<PlannedSegment[]> {
  const { projectId, jobId, projectTitle, transcript, words, voiceoverDuration } = input;
  const language = input.language ?? DEFAULT_LANGUAGE;
  let avatarRanges = input.avatarRanges ?? [];
  if (!transcript.trim()) throw new Error("buildSyntheticTimeline: empty transcript");

  // Derive the video's niche ONCE so every chunk's basePrompt + imagePrompts
  // stay on-theme (the off-topic-visuals fix). Cheap, fault-tolerant call.
  // Carries `language` out on the topic, which is how the region and the
  // answer-in-English rule reach every downstream prompt builder.
  const topic = await deriveVideoTopic({
    projectId,
    jobId,
    title: projectTitle ?? "",
    transcript,
    language,
  });

  // A long transcript makes Gemini emit a segments array that overflows its
  // output-token budget and truncates the JSON mid-stream — surfacing as the
  // misleading "Gemini returned non-JSON". So we split the transcript at
  // sentence boundaries into chunks small enough that each response fits, plan
  // each chunk in its own call, then concatenate the segments in order. A short
  // transcript yields a single chunk (one call), so this is a no-op for the
  // common case. Gemini 2.5-flash also hits intermittent 503 "high demand"
  // spikes; planTranscriptChunk waits those out (6 attempts) and falls back to
  // GEMINI_FALLBACK_MODEL before giving up, per chunk.
  const maxChars = getEnv().SYNTHETIC_PLANNER_MAX_CHARS_PER_CALL;

  // basePrompt is a whole-video style bible; the first chunk reads enough of the
  // script to set it for everyone, so we adopt the first chunk's and ignore the
  // rest (they'd only describe their own slice).
  let basePrompt = "";
  let planned: PlannedSegment[];

  const alignFirst = getEnv().SYNTHETIC_PLAN_ALIGN_FIRST;
  if (alignFirst) {
    // ---- ALIGN-FIRST PATH -------------------------------------------------
    // Time the transcript's own sentences, THEN ask Gemini only to group them.
    // Nothing downstream searches the audio for Gemini's text, so the desync
    // that stranded a whole plan behind its voiceover cannot occur.
    const timed = buildTimedSentences({ transcript, words, voiceoverDuration, language });
    if (timed.sentences.length === 0) {
      throw new Error("buildSyntheticTimeline: transcript produced no sentences");
    }
    await logJob({ projectId, jobId }, "synthetic.plan.sentences_timed", {
      sentences: timed.sentences.length,
      anchored: timed.anchored,
      interpolated: timed.interpolated,
      anchoredFraction: Math.round(timed.anchoredFraction * 1000) / 1000,
      hasWordTimings: !!words?.length,
      voiceoverDuration,
    });

    // Alarm the old path never had. A collapsed anchor fraction means the word
    // timings and the transcript disagree (wrong voiceover, bad Deepgram run,
    // edited script) — every window past the collapse would be interpolated
    // guesswork. Fail here instead of shipping it to the review screen. Only
    // meaningful when we HAVE timings; without them everything is interpolated
    // by definition and the proportional fit is the intended degraded mode.
    const minAnchor = getEnv().SYNTHETIC_PLAN_MIN_ANCHOR_FRACTION;
    if (words?.length && timed.anchoredFraction < minAnchor) {
      throw new Error(
        `buildSyntheticTimeline: only ${(timed.anchoredFraction * 100).toFixed(0)}% of ` +
          `${timed.sentences.length} sentences anchored to the voiceover (need ` +
          `${(minAnchor * 100).toFixed(0)}%) — the transcript and the voiceover audio ` +
          `do not match. Re-generate the voiceover or re-import the script.`,
      );
    }

    const ranges = chunkSentenceRanges(timed.sentences, maxChars);
    if (ranges.length > 1) {
      await logJob({ projectId, jobId }, "synthetic.plan.chunked", {
        chunks: ranges.length,
        sentences: timed.sentences.length,
        maxCharsPerCall: maxChars,
        path: "align_first",
      });
    }

    const allBlocks: SentenceBlock[] = [];
    let repairedTotal = 0;
    let droppedTotal = 0;
    for (let i = 0; i < ranges.length; i++) {
      const { from, to } = ranges[i];
      const { basePrompt: bp, blocks } = await planSentenceChunk(
        { projectId, jobId },
        timed.sentences,
        from,
        to,
        `${i + 1}/${ranges.length}`,
        topic,
      );
      if (i === 0) basePrompt = await applyBasePromptGuard(bp, { projectId, jobId });
      // Gemini's grouping is a suggestion; the partition is not. Repair each
      // chunk against its OWN range so a chunk can never bleed into another.
      const fixed = repairCoverage(blocks, from, to);
      repairedTotal += fixed.repaired;
      droppedTotal += fixed.dropped;
      allBlocks.push(...fixed.blocks);
    }
    if (allBlocks.length === 0) {
      throw new Error("buildSyntheticTimeline: planner produced no segments");
    }
    if (repairedTotal > 0 || droppedTotal > 0) {
      await logJob({ projectId, jobId }, "synthetic.plan.coverage_repaired", {
        blocks: allBlocks.length,
        rangesRepaired: repairedTotal,
        blocksDropped: droppedTotal,
      });
    }
    planned = segmentsFromSentenceBlocks(allBlocks, timed.sentences, transcript);

    // DOMINANCE CHECK — must run HERE, on the raw grouping, not after the
    // later passes. repairCoverage guarantees every sentence is covered, so a
    // Gemini response that stops early doesn't lose the tail: it hands the
    // whole remainder to the last block. That block is then perfectly valid
    // arithmetic and splitByDuration will happily carve it into dozens of
    // ~6s slots that all repeat the same script — which is precisely how 12
    // minutes of one sentence reached the review screen. Once carved, nothing
    // downstream can tell those slots apart from legitimate ones, so this is
    // the last moment the anomaly is visible.
    //
    // Calibrated on the 32-min Jubilees script: a healthy grouping's longest
    // raw block is 27.9s against a 6.3s median, so 8x-the-median (floor 45s)
    // leaves ~1.8x headroom while still firing when Gemini stops even 10
    // sentences short. Avatar coalescing and the carve passes all run LATER,
    // so nothing legitimately long exists yet at this point.
    {
      const durations = planned.map((s) => s.duration).sort((a, b) => a - b);
      const median = durations[Math.floor(durations.length / 2)] ?? 0;
      const longest = durations[durations.length - 1] ?? 0;
      const ceiling = Math.max(45, median * 8);
      if (longest > ceiling) {
        const worst = planned.find((s) => s.duration === longest);
        throw new Error(
          `buildSyntheticTimeline: one block covers ${longest.toFixed(1)}s ` +
            `(median ${median.toFixed(1)}s, ceiling ${ceiling.toFixed(1)}s) — the planner ` +
            `did not group the whole script. Block at ${worst?.startTime.toFixed(1)}s: ` +
            `"${(worst?.script ?? "").slice(0, 80)}"`,
        );
      }
    }

    await logJob({ projectId, jobId }, "synthetic.plan.align_first", {
      blocks: planned.length,
      timelineSeconds:
        planned.length > 0 ? planned[planned.length - 1].endTime - planned[0].startTime : 0,
      voiceoverDuration,
    });
  } else {
    // ---- LEGACY PATH (SYNTHETIC_PLAN_ALIGN_FIRST=0) -----------------------
    // Kept for rollback only. Its timing comes from searching the word stream
    // for Gemini's paraphrased block text; see alignSegments for why that
    // fails silently.
    const chunks = chunkTranscriptBySentence(transcript, maxChars);
    if (chunks.length > 1) {
      await logJob({ projectId, jobId }, "synthetic.plan.chunked", {
        chunks: chunks.length,
        transcriptChars: transcript.trim().length,
        maxCharsPerCall: maxChars,
        path: "legacy",
      });
    }
    const rawSegments: RawSegment[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const { basePrompt: bp, segments } = await planTranscriptChunk(
        { projectId, jobId },
        chunks[i],
        `${i + 1}/${chunks.length}`,
        topic,
      );
      if (i === 0) basePrompt = await applyBasePromptGuard(bp, { projectId, jobId });
      rawSegments.push(...segments);
    }
    if (rawSegments.length === 0) {
      throw new Error("buildSyntheticTimeline: planner produced no segments");
    }
    planned = alignSegments(rawSegments, words, voiceoverDuration);
  }

  // Diagnostic: Gemini's RAW block-type choice, BEFORE any avatar-marking,
  // capping, promotion, or merging. This is the ground truth for "did Gemini
  // pick any split_2 at all?" — if rawSplit2 is 0, the downstream split_2 floor
  // (promotion) is what makes the layout appear; if it's non-zero but the final
  // plan has none, a later pass is consuming them.
  await logJob({ projectId, jobId }, "synthetic.plan.raw_types", {
    total: planned.length,
    byType: PLANNER_BLOCK_TYPES.reduce<Record<string, number>>((acc, t) => {
      acc[t] = planned.filter((p) => p.blockType === t).length;
      return acc;
    }, {}),
  });

  // Force avatar on segments that overlap a red/orange doc mark.
  //
  // We locate each segment's char window in the transcript so we can test it
  // against the avatar ranges. Gemini does NOT return verbatim transcript
  // slices (it normalizes punctuation/spacing), so an exact indexOf is
  // unreliable and a single miss makes the cursor drift, mis-marking every
  // following segment. Instead we map through a NORMALIZED projection: build a
  // lowercase, punctuation-stripped copy of the transcript while keeping an
  // index back to the original offsets, then find each segment's normalized
  // script within it. This tolerates Gemini's rewording and never drifts.
  if (avatarRanges.length > 0) {
    // Snap each hand-drawn doc range out to whole-sentence boundaries FIRST, so a
    // highlight that stops mid-sentence (e.g. "...a boy and" with "a girl." left
    // unmarked in the same sentence) covers the WHOLE sentence and splitByMarks
    // never strands a fragment onto the next visual block. Marking is
    // sentence-granular by design.
    const snappedRanges = snapRangesToSentences(transcript, avatarRanges);
    await logJob({ projectId, jobId }, "synthetic.plan.avatar_ranges_snapped", {
      before: avatarRanges.length,
      after: snappedRanges.length,
      markedCharsBefore: avatarRanges.reduce((a, r) => a + (r.end - r.start), 0),
      markedCharsAfter: snappedRanges.reduce((a, r) => a + (r.end - r.start), 0),
    });
    avatarRanges = snappedRanges;
    // normChars[i] = original transcript offset of the i-th normalized char.
    let normStr = "";
    const normToOrig: number[] = [];
    {
      let prevSpace = true;
      for (let i = 0; i < transcript.length; i++) {
        const ch = transcript[i].toLowerCase();
        const keep = /[a-z0-9]/.test(ch);
        if (keep) {
          normStr += ch; normToOrig.push(i); prevSpace = false;
        } else if (!prevSpace) {
          normStr += " "; normToOrig.push(i); prevSpace = true;
        }
      }
    }
    // Normalize the NEEDLE the SAME way normStr is built: lowercase, collapse
    // every run of non-alphanumerics to a single space, trim. The module-level
    // norm() strips spaces entirely, which would never match normStr (which has
    // single spaces between words) — that mismatch silently disabled all avatar
    // marking, so Gemini's own block-type choices leaked through unchanged.
    const normNeedle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    let searchFrom = 0;
    let placed = 0;
    let forced = 0;
    let unplaced = 0;
    let split = 0;
    const result: PlannedSegment[] = [];
    let exact = 0;
    for (const seg of planned) {
      // Align-first blocks carry their real transcript offsets (they were built
      // FROM sentence offsets), so marking is an index intersection — no search,
      // no drift, no misses. This is the second fuzzy matcher the align-first
      // change removes; the normalized-indexOf path below is the legacy
      // fallback for blocks with no offsets.
      if (seg.charStart !== undefined && seg.charEnd !== undefined) {
        exact++;
        const pieces = splitByMarks(seg, seg.charStart, seg.charEnd, avatarRanges, basePrompt);
        if (pieces.length > 1) split++;
        for (const p of pieces) {
          if (p.blockType === "avatar") forced++;
          result.push(p);
        }
        placed++;
        continue;
      }
      const needle = normNeedle(seg.script);
      if (!needle) {
        result.push(applyMark(seg, false, basePrompt));
        continue;
      }
      const at = normStr.indexOf(needle, searchFrom);
      // Whether or not we can locate the segment, doc marks are AUTHORITATIVE:
      // a segment is avatar IFF its text falls inside a marked range. So the
      // DEFAULT for any segment is "not avatar" — we only promote to avatar on
      // a confirmed overlap. A segment that can't be placed, or that Gemini
      // wrongly chose as avatar, is corrected to a non-avatar type.
      //
      // Marks are sub-segment precise: when a doc highlight covers only PART of
      // a Gemini block, we SPLIT the block at the mark boundary rather than
      // promote the whole block — so the marked half becomes avatar and the
      // unmarked half keeps its visual type.
      if (at < 0) {
        unplaced++;
        result.push(applyMark(seg, false, basePrompt));
        continue;
      }
      placed++;
      const origStart = normToOrig[at];
      const origEnd = (normToOrig[at + needle.length - 1] ?? origStart) + 1;
      // Advance the cursor only on a real match so a single miss can't strand
      // the rest. Re-anchor search from just after this match.
      searchFrom = at + needle.length;
      const pieces = splitByMarks(seg, origStart, origEnd, avatarRanges, basePrompt);
      if (pieces.length > 1) split++;
      for (const p of pieces) {
        if (p.blockType === "avatar") forced++;
        result.push(p);
      }
    }
    // Renumber positions after any splits so they stay 0..n-1 in order.
    result.forEach((p, i) => { p.position = i; });
    planned = result;
    await logJob({ projectId, jobId }, "synthetic.plan.avatar_marks", {
      ranges: avatarRanges.length,
      transcriptChars: transcript.length,
      markedChars: avatarRanges.reduce((a, r) => a + (r.end - r.start), 0),
      segmentsPlaced: placed,
      // Placed by exact char offsets (align-first) rather than text search.
      segmentsPlacedExact: exact,
      segmentsUnplaced: unplaced,
      segmentsSplit: split,
      segmentsTotal: planned.length,
      avatarForced: forced,
    });
  }

  // Avatar coalesce pass. Merge contiguous avatar segments into one atomic
  // avatar "part" so the audio-driven HeyGen flow does ONE render per Google-Doc
  // avatar passage (sliced audio upload), not one per ~6s sub-block. Runs AFTER
  // avatar-marking (so a marked range split across Gemini blocks is rejoined)
  // and BEFORE the duration-split pass (which only touches non-avatar blocks, so
  // ordering is safe either way, but coalescing first keeps positions clean).
  {
    const before = planned.length;
    const { segments, merged, overLengthParts } = coalesceAvatarSegments(planned);
    if (merged > 0) {
      segments.forEach((p, i) => { p.position = i; });
      planned = segments;
      await logJob({ projectId, jobId }, "synthetic.plan.avatar_coalesce", {
        segmentsBefore: before,
        segmentsAfter: planned.length,
        partsMerged: merged,
        overLengthParts,
      });
    }
  }

  // split_2 cap pass (client feedback 2026-06: "too many split_2 parts"). Gemini
  // over-chooses split_2; demote the excess to plain 'image' so only a small
  // share remains. Runs AFTER avatar-marking/coalescing (a doc-marked avatar is
  // never a split_2, so it's untouched) and BEFORE the clip-heavy + duration
  // passes (so a demoted image can still be promoted to ai_clip in the intro and
  // carved by duration-split like any other image).
  {
    const maxFraction = getEnv().SYNTHETIC_SPLIT2_MAX_FRACTION;
    const minGap = getEnv().SYNTHETIC_SPLIT2_MIN_GAP;
    // FRACTION BAND (5-8% since 2026-07-22; was 10-15% per 2026-07-07 — the
    // client asked to reduce split_2 again). maxFraction is the ceiling; the
    // floor is the LARGER of the fixed MIN_KEEP count and MIN_FRACTION of total
    // blocks — so a plan with plenty of split_2 settles inside the band instead
    // of being scraped to a token few, while a short video still keeps a couple
    // when the fraction rounds below the fixed count. This only holds split_2
    // Gemini already chose (the capper demotes excess, never promotes), so it's
    // a don't-demote-below floor, not a forced minimum. PRECEDENCE: the MIN_GAP
    // spacing rule still wins over the floor — a heavily CLUSTERED section can
    // land below the floor because spreading a clump matters more to the client
    // than hitting the exact band (they explicitly rejected consecutive
    // split_2). In a normally-spread video the band binds.
    const minFraction = getEnv().SYNTHETIC_SPLIT2_MIN_FRACTION;
    const fracFloor = minFraction > 0 ? Math.ceil(planned.length * minFraction) : 0;
    const minKeep = Math.max(getEnv().SYNTHETIC_SPLIT2_MIN_KEEP, fracFloor);
    const before = planned.filter((p) => p.blockType === "split_2").length;
    // FRONT-LOADING (client 2026-08-18): 80% of the allowance goes to the first
    // 12 minutes. This only redistributes WHERE the kept split_2 sit; the band
    // above still decides how many there are.
    const frontSeconds = getEnv().SYNTHETIC_SPLIT2_FRONT_SECONDS;
    const frontShare = getEnv().SYNTHETIC_SPLIT2_FRONT_SHARE;
    const { segments, demoted, keptFront, keptRest } =
      capSplit2Blocks(planned, maxFraction, minKeep, minGap, frontSeconds, frontShare,
        getEnv().SYNTHETIC_SPLIT2_FRONT_MIN_GAP);
    if (demoted > 0) {
      segments.forEach((p, i) => { p.position = i; });
      planned = segments;
      await logJob({ projectId, jobId }, "synthetic.plan.split2_cap", {
        maxFraction,
        minFraction,
        minKeep,
        minGap,
        frontSeconds,
        frontShare,
        split2Before: before,
        split2After: before - demoted,
        demotedToImage: demoted,
        keptFront,
        keptRest,
        // Achieved front share vs the requested one. Below target means the
        // front window did not contain enough split_2 to fill its quota and the
        // remainder spilled to the tail (see capSplit2Blocks pass 2).
        keptFrontPercent: keptFront + keptRest > 0
          ? Number(((keptFront / (keptFront + keptRest)) * 100).toFixed(1))
          : 0,
        totalBlocks: planned.length,
      });
    }
  }

  // split_2 DURATION cap (client 2026-07-03: a 38s split_2 held the same still
  // beside the presenter for 5 sentences). An over-long split_2 keeps its FIRST
  // sentence as the split_2; the remaining sentences become a plain image block.
  //
  // This runs TWICE: once here (after the count cap, before the clip-heavy +
  // duration passes, so the carved-off remainder is paced like any other long
  // image block) and once as the FINAL pass before persist. The second run is
  // required because split_2 is exempt from every carve pass (splitByDuration
  // skips it) and `ensureMinSplit2` can PROMOTE an image to split_2 AFTER this
  // early pass — a promotion the early cap never sees, which is how a 22.5s /
  // 5-sentence split_2 reached the review screen. The tag distinguishes the two
  // in the job log.
  const runSplit2DurationCap = async (tag: string) => {
    const maxSeconds = getEnv().SYNTHETIC_SPLIT2_MAX_SECONDS;
    if (maxSeconds <= 0) return;
    const { segments, carved, demoted, regen } = capSplit2Duration(planned, maxSeconds);
    if (carved === 0 && demoted === 0) return;
    // Each carved piece now covers only PART of the passage its inherited
    // imagePrompt described, so regenerate a prompt for each piece's own script.
    // A regen failure is non-fatal — the piece keeps the parent's prompt
    // (sub-optimal but renderable), the pacing win still lands.
    let regenerated = 0;
    let regenFailed = 0;
    const capLimit = makeLimit(5);
    await Promise.all(
      regen.map((p) =>
        capLimit(async () => {
          try {
            const r = await regenerateSegmentPrompt({
              projectId,
              jobId,
              script: p.script,
              basePrompt,
              blockType: p.blockType,
              language,
            });
            // Composed WITH the base in front (like the merge pass), so clear
            // shotType — persist's composePrompt sees the base already present
            // and passes it through unchanged.
            p.imagePrompt = r.imagePrompt;
            p.shotType = null;
            regenerated++;
          } catch {
            regenFailed++;
          }
        }),
      ),
    );
    segments.forEach((p, i) => { p.position = i; });
    planned = segments;
    await logJob({ projectId, jobId }, "synthetic.plan.split2_duration_cap", {
      pass: tag,
      maxSeconds,
      blocksCarved: carved,
      blocksDemoted: demoted,
      promptsRegenerated: regenerated,
      promptRegenFailed: regenFailed,
      totalBlocks: planned.length,
    });
  };
  await runSplit2DurationCap("early");

  // Clip-heavy intro pass (client requirement 2026-06). The reference channel
  // opens with mostly MOVING footage and switches to still images later to save
  // credits. Promote every 'image' block whose spoken window STARTS before
  // SYNTHETIC_CLIP_HEAVY_SECONDS to an 'ai_clip' so the opening stretch is
  // animated; blocks after the cutoff keep Gemini's choice (stills dominate).
  //
  // Runs AFTER avatar-marking and coalescing (so it never touches an avatar
  // block or overrides a doc mark — only plain 'image' blocks are promoted) and
  // BEFORE the duration-split pass (so a promoted long clip is still carved into
  // LTX-tier pieces with the usual clip-then-fill-image handling).
  //
  // A promoted block has no animationPrompt from Gemini (it was an 'image').
  // It is left null HERE -- the later fill pass writes one from the block's own
  // narration once every type pass has run, which is the only point where the
  // block's final scene is known. Before that pass existed this null reached the
  // worker and became a generic fallback motion unrelated to the line being
  // spoken, which is the "clips do not match" report of 2026-08-25.
  {
    const cutoff = getEnv().SYNTHETIC_CLIP_HEAVY_SECONDS;
    if (cutoff > 0) {
      let promoted = 0;
      for (const seg of planned) {
        if (seg.blockType === "image" && seg.startTime < cutoff) {
          seg.blockType = "ai_clip";
          promoted++;
        }
      }
      if (promoted > 0) {
        await logJob({ projectId, jobId }, "synthetic.plan.clip_heavy_intro", {
          cutoffSeconds: cutoff,
          blocksPromoted: promoted,
        });
      }
    }
  }

  // Duration-split pass. Gemini's per-block sizing is a soft prompt hint, so
  // it routinely emits long blocks (a long sentence -> a 13-21s ai_clip). The
  // client's reference video paces every visual block at ~3-8s, and LTX-2
  // can't animate a 21s still in one call. Carve any visual block longer than
  // the threshold into ~target-second sub-blocks. Runs AFTER avatar-mark
  // splitting so a sub-block that was promoted to 'avatar' is correctly
  // exempted. Renumber positions afterward so they stay 0..n-1.
  {
    const env = getEnv();
    const target = env.SYNTHETIC_BLOCK_TARGET_SECONDS;
    const threshold = env.SYNTHETIC_BLOCK_SPLIT_THRESHOLD;
    let durSplit = 0;
    const out: PlannedSegment[] = [];
    for (const seg of planned) {
      const pieces = splitByDuration(seg, target, threshold);
      if (pieces.length > 1) durSplit++;
      out.push(...pieces);
    }
    if (out.length !== planned.length) {
      out.forEach((p, i) => { p.position = i; });
      await logJob({ projectId, jobId }, "synthetic.plan.duration_split", {
        targetSeconds: target,
        thresholdSeconds: threshold,
        blocksSplit: durSplit,
        segmentsBefore: planned.length,
        segmentsAfter: out.length,
      });
      planned = out;
    }
  }

  // Merge-short-visuals pass (client feedback 2026-06: image switches too often,
  // ~1s between — slow everything down to ~5-6s). Runs LAST of the timeline
  // passes so it is the final word on pacing: a SHORT image/ai_clip sentence is
  // merged INTO the previous same-type sentence so the two render as ONE visual
  // instead of two flashes, until each merged block reaches the minimum hold.
  // avatar and split_2 blocks are never merged. Each merged block now covers two
  // sentences, so we regenerate ONE combined imagePrompt for its merged script
  // (the stored prompt was the first sentence's only). Renumber positions
  // afterward so they stay 0..n-1.
  {
    const minHold = getEnv().SYNTHETIC_BLOCK_MIN_HOLD;
    const maxHold = getEnv().SYNTHETIC_BLOCK_SPLIT_THRESHOLD;
    if (minHold > 0) {
      const before = planned.length;
      const { segments, merged } = mergeShortVisualSegments(planned, minHold, maxHold);
      if (merged > 0) {
        // Regenerate one combined imagePrompt per merged block so the visual
        // reflects BOTH sentences, not just the first. We reuse the same
        // single-block regenerator the review screen uses. A regen failure is
        // non-fatal: we keep the first sentence's prompt (already on the row)
        // rather than failing the whole plan — the merge's pacing win still
        // lands, only that one block's prompt is sub-optimal.
        let regenerated = 0;
        let regenFailed = 0;
        // Regenerate in PARALLEL with a concurrency cap. These blocks have no
        // cross-item dependency (each mutates only its own fields), so running
        // them one-at-a-time serialized ~74 Gemini calls behind each other —
        // the dominant cost of the 2026-07 planner slowdown when 2.5-flash was
        // broadly 503ing. The limiter keeps ~5 in flight so a spike doesn't fan
        // out into its own throttle, while collapsing the wall-time ~5x.
        const mergeLimit = makeLimit(5);
        await Promise.all(
          segments
            .filter((p) => p.needsPromptRegen && p.blockType !== "avatar")
            .map((p) =>
              mergeLimit(async () => {
                try {
                  const r = await regenerateSegmentPrompt({
                    projectId,
                    jobId,
                    script: p.script,
                    basePrompt,
                    blockType: p.blockType,
                    language,
                  });
                  // regenerateSegmentPrompt returns a prompt already composed WITH
                  // the base in front and the shot folded in, so clear shotType and
                  // the second-visual nudge — persist's composePrompt sees the base
                  // already present and passes it through unchanged.
                  p.imagePrompt = r.imagePrompt;
                  p.shotType = null;
                  p.secondVisual = false;
                  if (p.blockType === "ai_clip") p.animationPrompt = r.animationPrompt;
                  regenerated++;
                } catch {
                  regenFailed++;
                }
              }),
            ),
        );
        // Re-split any merged block whose combined window exceeds the cap into
        // even ~minHold slots, so a 7s + 2.6s pair plays as TWO ~4.8s visuals
        // (slot 1 = combined prompt, slots 2+ = a different angle) instead of
        // one over-long hold. Runs AFTER the regen loop so slot 1 carries the
        // combined prompt; each slot ends up < maxHold (clips stay animatable).
        const { segments: resplit, split: blocksResplit } =
          splitMergedVisuals(segments, minHold, maxHold);
        resplit.forEach((p, i) => { p.position = i; });
        planned = resplit;
        await logJob({ projectId, jobId }, "synthetic.plan.merge_short_visuals", {
          minHoldSeconds: minHold,
          maxHoldSeconds: maxHold,
          blocksMerged: merged,
          promptsRegenerated: regenerated,
          promptRegenFailed: regenFailed,
          blocksResplit,
          segmentsBefore: before,
          segmentsAfter: planned.length,
        });
      }
    }
  }

  // FINAL image/ai_clip balance by position. Runs LAST so the short-visual
  // merge's clip-bias can't undo it: before the clip-heavy cutoff visuals hold
  // SYNTHETIC_INTRO_CLIP_FRACTION as evenly-spaced clips (client 2026-07-22:
  // 30% clips / 70% images for the first 15 min — LTX cost cut); after it, only
  // postFraction stay clips (default 0 = all stills, "no more LTX after 15
  // minutes"). split_2 and avatar are untouched.
  {
    const cutoff = getEnv().SYNTHETIC_CLIP_HEAVY_SECONDS;
    const postFraction = getEnv().SYNTHETIC_POST_INTRO_CLIP_FRACTION;
    const introClipRun = getEnv().SYNTHETIC_INTRO_CLIP_RUN;
    const introImageRun = getEnv().SYNTHETIC_INTRO_IMAGE_RUN;
    const introFraction = getEnv().SYNTHETIC_INTRO_CLIP_FRACTION;
    const { segments, toClip, toImage } = balanceVisualTypesByPosition(
      planned, cutoff, postFraction, introClipRun, introImageRun, introFraction,
    );
    if (toClip > 0 || toImage > 0) {
      planned = segments;
      await logJob({ projectId, jobId }, "synthetic.plan.visual_balance", {
        clipHeavyCutoffSeconds: cutoff,
        postIntroClipFraction: postFraction,
        introClipFraction: introFraction,
        introClipRun,
        introImageRun,
        flippedToClip: toClip,
        flippedToImage: toImage,
        byTypeAfter: PLANNER_BLOCK_TYPES.reduce<Record<string, number>>((acc, t) => {
          acc[t] = planned.filter((p) => p.blockType === t).length;
          return acc;
        }, {}),
      });
    }
  }

  // split_2 FLOOR. Gemini sometimes returns FAR fewer split_2 than the client's
  // band wants — on a 300-part video it routinely picks just 2-6, so the
  // layout barely appears (client: "the split count is only 2 or 10 although
  // there are 250 parts"). Promote evenly-spaced post-intro 'image' blocks up to
  // the SAME band floor the cap pass uses — max(MIN_KEEP, ceil(total *
  // MIN_FRACTION)) — so a long video reaches the band floor instead of the
  // fixed count of 2. Runs AFTER the visual balance so the balance pass can't
  // flip a promotion back to image. The cap pass (which only DEMOTES) enforces
  // the band's upper edge (MAX_FRACTION); this promoter enforces the lower edge
  // (MIN_FRACTION, 5% since 2026-07-22). Both must use the fractional floor or
  // the band only binds from one side (the bug that let long videos sit at <2%
  // split_2).
  {
    const minFraction = getEnv().SYNTHETIC_SPLIT2_MIN_FRACTION;
    const fracFloor = minFraction > 0 ? Math.ceil(planned.length * minFraction) : 0;
    const minKeep = Math.max(getEnv().SYNTHETIC_SPLIT2_MIN_KEEP, fracFloor);
    // The no-promotions window is the PHASE-1 clip window (3 min since the
    // 2026-08-20 trim, previously 4), not the old 15-minute clip-heavy cutoff.
    // Two client asks conflict there — the clip-heavy opening and "80% of
    // splitscreens in the first 12 min" — and a split_2 is not a clip, so
    // promoting inside the opening window would eat the very blocks the phase-1
    // clip target needs. Keeping the opening clear leaves 3-12 min to carry the
    // front share. Falls back to the clip-heavy cutoff when phase 1 is disabled.
    const cutoff = getEnv().SYNTHETIC_CLIP_PHASE1_SECONDS > 0
      ? getEnv().SYNTHETIC_CLIP_PHASE1_SECONDS
      : getEnv().SYNTHETIC_CLIP_HEAVY_SECONDS;
    const frontSeconds = getEnv().SYNTHETIC_SPLIT2_FRONT_SECONDS;
    const frontShare = getEnv().SYNTHETIC_SPLIT2_FRONT_SHARE;
    const haveBefore = planned.filter((p) => p.blockType === "split_2").length;
    const { segments, promoted, promotedFront } =
      ensureMinSplit2(planned, minKeep, cutoff, frontSeconds, frontShare);
    if (promoted > 0) {
      planned = segments;
      const finalFront = planned.filter(
        (p) => p.blockType === "split_2" && p.startTime < frontSeconds,
      ).length;
      const finalTotal = haveBefore + promoted;
      await logJob({ projectId, jobId }, "synthetic.plan.split2_floor", {
        minKeep,
        minFraction,
        fracFloor,
        introCutoffSeconds: cutoff,
        frontSeconds,
        frontShare,
        totalBlocks: planned.length,
        split2Before: haveBefore,
        promotedFromImage: promoted,
        promotedIntoFrontWindow: promotedFront,
        split2After: finalTotal,
        // FINAL placement across the whole plan — the number to check against
        // the client's 80/20 ask. Short of target means the front window ran out
        // of eligible 'image' blocks (heavily avatar-marked, or already clips).
        split2InFrontWindow: finalFront,
        split2FrontPercent: finalTotal > 0
          ? Number(((finalFront / finalTotal) * 100).toFixed(1))
          : 0,
      });
    }

    // FRONT-SHARE REBALANCE (client 2026-08-18: 80% of split_2 in the first 12
    // min). The cap pass front-loads only what Gemini already put in the front
    // window and the floor pass only fires below the band floor, so a plan that
    // is inside the band but back-loaded satisfies both and still misses the
    // placement rule. This trades tail split_2 for front ones at a fixed total.
    // Runs last of the split_2 type passes; the DURATION cap below still gets to
    // carve anything it promotes.
    if (frontSeconds > 0 && frontShare > 0) {
      const r = rebalanceSplit2ToFront(planned, {
        frontSeconds,
        frontShare,
        introCutoffSeconds: cutoff,
        minGap: getEnv().SYNTHETIC_SPLIT2_MIN_GAP,
        frontMinGap: getEnv().SYNTHETIC_SPLIT2_FRONT_MIN_GAP,
      });
      if (r.moved > 0) {
        planned = r.segments;
        await logJob({ projectId, jobId }, "synthetic.plan.split2_front_rebalance", {
          frontSeconds,
          frontShare,
          totalSplit2: r.total,
          frontBefore: r.frontBefore,
          frontAfter: r.frontAfter,
          movedFromTailToFront: r.moved,
          frontPercent: r.total > 0 ? Number(((r.frontAfter / r.total) * 100).toFixed(1)) : 0,
          // Short of the requested share means the front window ran out of
          // promotable images (heavily avatar-marked or already clips) or the
          // spacing rule blocked the remaining slots.
          targetFront: Math.round(r.total * frontShare),
        });
      }
    }
  }

  // CLIP BUDGET BY DURATION, TWO PHASES (client 2026-08-20: "the first 3 min,
  // 65 % ltx clips and 35 % images. After 3 mins, 70% images and 30% clips" —
  // the latter being the unchanged 20% LTX + 10% VEO from 2026-08-18, with only
  // the opening window trimmed for cost). Runs LAST of the type passes so nothing downstream can
  // undo it — the split_2 floor above promotes images, which would otherwise eat
  // into the clip budget after it was measured.
  {
    const env = getEnv();
    const phase1Seconds = env.SYNTHETIC_CLIP_PHASE1_SECONDS;
    const veoEnabled = env.SYNTHETIC_VEO_ENABLED;
    const basis = env.SYNTHETIC_CLIP_FRACTION_BASIS;
    const cutoff = env.SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF
      ? env.SYNTHETIC_CLIP_HEAVY_SECONDS
      : 0;
    // phase1Seconds 0 collapses to the single tail phase over the whole video,
    // which is the pre-2026-08-18 flat budget.
    const phases: ClipPhase[] = parseClipSchedule(
      env.SYNTHETIC_CLIP_SCHEDULE,
      env.SYNTHETIC_CLIP_SCHEDULE_VEO_FRACTION,
    );
    // A schedule REPLACES the two-phase model entirely; appending phase2_body on
    // top of it would re-open the tail the schedule deliberately closes to 0.
    const usingSchedule = phases.length > 0;
    if (!usingSchedule) {
      if (phase1Seconds > 0) {
        phases.push({
          startSeconds: 0,
          endSeconds: phase1Seconds,
          clipFraction: env.SYNTHETIC_CLIP_PHASE1_CLIP_FRACTION,
          veoFraction: env.SYNTHETIC_CLIP_PHASE1_VEO_FRACTION,
          label: "phase1_opening",
        });
      }
      phases.push({
        startSeconds: phase1Seconds > 0 ? phase1Seconds : 0,
        endSeconds: Infinity,
        clipFraction: env.SYNTHETIC_CLIP_DURATION_FRACTION,
        veoFraction: env.SYNTHETIC_VEO_DURATION_FRACTION,
        label: "phase2_body",
      });
    }
    if (phases.some((p) => p.clipFraction > 0 || p.veoFraction > 0)) {
      const q = assignClipDurationQuota(planned, {
        phases,
        basis,
        veoEnabled,
        cutoffSeconds: cutoff,
      });
      planned = q.segments;
      const pct = (s: number) => (q.totalSeconds > 0 ? Number(((s / q.totalSeconds) * 100).toFixed(1)) : 0);
      // Per-phase achieved share, measured against the SAME basis the target
      // used — a video-wide percentage cannot show whether the opening window
      // hit its 80%, which is the number the client is actually watching for.
      const phaseShare = (p: ClipQuotaPhaseResult, s: number) =>
        p.basisSeconds > 0 ? Number(((s / p.basisSeconds) * 100).toFixed(1)) : 0;
      await logJob({ projectId, jobId }, "synthetic.plan.clip_duration_quota", {
        basis,
        phase1Seconds,
        veoEnabled,
        cutoffSeconds: cutoff,
        totalSeconds: Math.round(q.totalSeconds),
        targetClipSeconds: Math.round(q.targetClipSeconds),
        clipSeconds: Math.round(q.clipSeconds),
        clipPercent: pct(q.clipSeconds),
        targetVeoSeconds: Math.round(q.targetVeoSeconds),
        veoSeconds: Math.round(q.veoSeconds),
        veoPercent: pct(q.veoSeconds),
        ltxBlocks: q.ltxBlocks,
        veoBlocks: q.veoBlocks,
        promotedToClip: q.promoted,
        demotedToImage: q.demoted,
        // Non-zero means there were not enough non-avatar blocks to hold the
        // budget — the doc is highlighted too heavily for the requested clip
        // share. Surfaced rather than silently missed.
        shortfallSeconds: Math.round(q.shortfallSeconds),
        phases: q.phases.map((p) => ({
          label: p.label,
          window: `${Math.round(p.startSeconds)}-${p.endSeconds === Infinity ? "end" : Math.round(p.endSeconds)}s`,
          basisSeconds: Math.round(p.basisSeconds),
          clipSeconds: Math.round(p.clipSeconds),
          clipPercent: phaseShare(p, p.clipSeconds),
          veoSeconds: Math.round(p.veoSeconds),
          veoPercent: phaseShare(p, p.veoSeconds),
          ltxBlocks: p.ltxBlocks,
          veoBlocks: p.veoBlocks,
          shortfallSeconds: Math.round(p.shortfallSeconds),
        })),
      });
      if (q.shortfallSeconds > 0) {
        await logJob({ projectId, jobId }, "synthetic.plan.clip_quota_shortfall", {
          note:
            "not enough non-avatar blocks to reach the clip duration target — " +
            "avatar blocks come from doc highlights and cannot be reassigned",
          shortfallSeconds: Math.round(q.shortfallSeconds),
          achievedPercent: pct(q.clipSeconds),
          // Which phase(s) actually missed. On the client's 2026-08-18 mix the
          // opening window is the one that can realistically starve: 80% of a
          // 4-minute window is a lot of clip seconds to find when the doc marks
          // much of it as avatar.
          missedPhases: q.phases
            .filter((p) => p.shortfallSeconds > 0)
            .map((p) => ({
              label: p.label,
              shortfallSeconds: Math.round(p.shortfallSeconds),
              achievedPercent: phaseShare(p, p.clipSeconds),
              targetPercent: p.basisSeconds > 0
                ? Number(((p.targetClipSeconds / p.basisSeconds) * 100).toFixed(1))
                : 0,
            })),
        });
      }
    }
  }

  // DISTINCT-SCENE pass for the EXTRA visuals of one sentence (client 2026-06-30:
  // "if several images are generated in the same sentence, the image is the same
  // now"). When a sentence is shown with MULTIPLE visuals, every slot after the
  // first is flagged `secondVisual` and, until now, reused slot 1's imagePrompt
  // with only a weak "different angle" text nudge — which nano-banana renders as a
  // near-clone (the exact failure the imagePrompt2 system documents). That nudge
  // also never covered the 3rd+ slot from splitMergedVisuals at all.
  //
  // So here, for EACH secondVisual slot, regenerate a GENUINELY DIFFERENT scene of
  // the same sentence, telling Gemini which scenes the earlier slots already show
  // (avoidScenes) so it picks a new subject/moment/detail. Slots are grouped into
  // "same sentence" runs by their identical script: a non-secondVisual anchor
  // followed by its secondVisual slots. A regen failure is non-fatal — that one
  // slot keeps the old angle-nudge prompt (set below via secondVisualPrompt at
  // persist) rather than failing the whole plan.
  {
    let distinctRegenerated = 0;
    let distinctRegenFailed = 0;
    // First collect each sentence's run of secondVisual slots (an anchor +
    // its following same-script slots). The `avoid` chaining is sequential
    // WITHIN a run (each slot avoids the earlier slots' scenes), so slots in
    // one run can't be parallelized against each other — but DIFFERENT runs
    // are independent. So we process runs in parallel with a concurrency cap
    // and keep each run's slots sequential, cutting wall-time without breaking
    // the avoid-chaining that makes the extra visuals distinct.
    const runs: { anchor: PlannedSegment; slots: PlannedSegment[] }[] = [];
    let i = 0;
    while (i < planned.length) {
      const anchor = planned[i];
      if (anchor.blockType === "avatar" || anchor.secondVisual) { i++; continue; }
      const slots: PlannedSegment[] = [];
      let j = i + 1;
      while (
        j < planned.length &&
        planned[j].secondVisual &&
        planned[j].blockType !== "avatar" &&
        planned[j].script === anchor.script
      ) {
        slots.push(planned[j]);
        j++;
      }
      if (slots.length > 0) runs.push({ anchor, slots });
      i = j > i + 1 ? j : i + 1;
    }

    const distinctLimit = makeLimit(5);
    await Promise.all(
      runs.map(({ anchor, slots }) =>
        distinctLimit(async () => {
          const avoid: string[] = [];
          const anchorScene = anchor.imagePrompt?.trim();
          if (anchorScene) avoid.push(anchorScene);
          // The anchor is picture 1 of the run; each slot is the next one.
          // Passing the position lets the regen build a PROGRESSION instead of
          // another independent variation — see the sequence block in
          // buildSingleSegmentPrompt for the measured failure this fixes.
          const runTotal = slots.length + 1;
          for (const [slotIdx, slot] of slots.entries()) {
            try {
              const r = await regenerateSegmentPrompt({
                projectId,
                jobId,
                script: slot.script,
                basePrompt,
                blockType: slot.blockType,
                language,
                avoidScenes: avoid,
                sequence: { index: slotIdx + 2, total: runTotal },
              });
              // regenerateSegmentPrompt returns a prompt already composed WITH the
              // base in front and the shot folded in, so clear shotType and the
              // second-visual nudge — persist's composePrompt passes it through.
              slot.imagePrompt = r.imagePrompt;
              slot.shotType = null;
              slot.secondVisual = false;
              if (slot.blockType === "ai_clip") slot.animationPrompt = r.animationPrompt;
              // The next slot of this sentence must also avoid THIS new scene.
              avoid.push(r.imagePrompt);
              distinctRegenerated++;
            } catch {
              distinctRegenFailed++;
              // Keep the existing scene in avoid so a later slot still differs from it.
              if (slot.imagePrompt?.trim()) avoid.push(slot.imagePrompt.trim());
            }
          }
        }),
      ),
    );
    if (distinctRegenerated > 0 || distinctRegenFailed > 0) {
      await logJob({ projectId, jobId }, "synthetic.plan.distinct_second_visuals", {
        regenerated: distinctRegenerated,
        regenFailed: distinctRegenFailed,
      });
    }
  }

  // WITHIN-VIDEO SCENE DEDUPE (client 2026-08-19 via Joey: "for example the
  // german video, it is showing spoons a lot, very similar images and similar
  // footages. I want more variation" / "can you hardcode it in that its not too
  // repetitive and it matches the script better").
  //
  // The pass above only de-duplicates the extra visuals of ONE sentence. This
  // one runs across the WHOLE plan: any block whose scene repeats an earlier
  // block's is regenerated against it, so a script that keeps returning to its
  // subject stops rendering the same picture every time. Runs AFTER the
  // second-visual pass (whose regenerations are themselves candidates here) and
  // after every block-type pass, so it sees the final scene list.
  //
  // Deliberately the SECOND half of the repetition fix — the first is the
  // cross-video reuse ceiling (ASSET_LIBRARY_MAX_REUSE_FRACTION, lowered to
  // 0.15 the same day). Reuse recycles assets between projects; this is about
  // one script talking about spoons forty times.
  //
  // A regen failure is non-fatal: that block keeps its original prompt.
  if (getEnv().SYNTHETIC_SCENE_DEDUPE_ENABLED) {
    const env = getEnv();
    // Only visual blocks carry a scene. Avatar blocks have no image prompt, and
    // split_2's right half does — it is just as capable of repeating.
    const scenes = planned.map((p) =>
      p.blockType === "avatar" ? null : (p.imagePrompt ?? null),
    );
    const { repeats: wordRepeats, flaggedTotal } = findRepeatedScenes(scenes, {
      basePrompt,
      similarity: env.SYNTHETIC_SCENE_DEDUPE_SIMILARITY,
      window: env.SYNTHETIC_SCENE_DEDUPE_WINDOW,
      maxRegen: env.SYNTHETIC_SCENE_DEDUPE_MAX_REGEN,
    });

    // SECOND PASS, on the SHAPE of the shot rather than its wording.
    //
    // findRepeatedScenes compares content words and therefore only ever sees
    // near-clones. Measured 2026-08-26 on five consecutive live blocks that were
    // all "a person's hand + a ground turkey package + a label": pairwise word
    // overlap 0.24-0.52, so ZERO of them were flagged at any threshold we could
    // ship. They are the same picture written five ways, and that is the
    // repetition the client keeps reporting.
    //
    // findRepeatedCompositions catches exactly those. Both passes feed ONE
    // regeneration below, and a block already flagged by the word pass is not
    // flagged twice -- its avoid list is the more specific of the two.
    const { repeats: shapeRepeats, flaggedTotal: shapeFlagged } = findRepeatedCompositions(scenes, {
      window: env.SYNTHETIC_SCENE_DEDUPE_WINDOW,
      maxRegen: env.SYNTHETIC_SCENE_DEDUPE_MAX_REGEN,
    });
    const seenIdx = new Set(wordRepeats.map((r) => r.index));
    const repeats: RepeatedScene[] = [
      ...wordRepeats,
      ...shapeRepeats
        .filter((r) => !seenIdx.has(r.index))
        .map((r) => ({ index: r.index, avoid: r.avoid, anchor: r.anchor, similarity: 1 })),
    ].sort((a, b) => a.index - b.index);

    if (shapeRepeats.length > 0) {
      await logJob({ projectId, jobId }, "synthetic.plan.composition_repeats", {
        flagged: shapeFlagged,
        regenerating: repeats.length - wordRepeats.length,
        note: "same shot shape, different wording — invisible to the word-overlap pass",
      });
    }

    if (repeats.length > 0) {
      // Blocks that duplicate the SAME earlier scene must also differ from each
      // OTHER, so each anchor's repeats form a chain processed sequentially with
      // an accumulating avoid list — otherwise five spoon blocks would each be
      // told "not that spoon shot" and could all land on the same new one.
      // Different anchors are independent, so chains run in parallel (same
      // shape as the second-visual pass above).
      const chains = new Map<number, RepeatedScene[]>();
      for (const r of repeats) {
        if (!chains.has(r.anchor)) chains.set(r.anchor, []);
        chains.get(r.anchor)!.push(r);
      }

      let dedupeRegenerated = 0;
      let dedupeFailed = 0;
      const dedupeLimit = makeLimit(5);
      await Promise.all(
        [...chains.values()].map((chain) =>
          dedupeLimit(async () => {
            const avoid = [...chain[0].avoid];
            for (const r of chain) {
              const seg = planned[r.index];
              try {
                const g = await regenerateSegmentPrompt({
                  projectId,
                  jobId,
                  script: seg.script,
                  basePrompt,
                  blockType: seg.blockType,
                  language,
                  avoidScenes: avoid,
                  // Repeat-flagged blocks are disproportionately the abstract
                  // connector lines; their neighbours' narration is what gives
                  // the regen something concrete to draw instead of the base
                  // world's modal scene again.
                  surroundingScript: [planned[r.index - 1]?.script, planned[r.index + 1]?.script]
                    .filter(Boolean)
                    .join(" "),
                });
                // Returns a prompt already composed WITH the base in front and
                // the shot folded in — clear shotType so persist's composePrompt
                // passes it through rather than prefixing a second shot.
                seg.imagePrompt = g.imagePrompt;
                seg.shotType = null;
                if (seg.blockType === "ai_clip") seg.animationPrompt = g.animationPrompt;
                avoid.push(g.imagePrompt);
                dedupeRegenerated++;
              } catch {
                dedupeFailed++;
                // Keep the old scene in avoid so the next link still differs
                // from what this block will actually show.
                if (seg.imagePrompt?.trim()) avoid.push(seg.imagePrompt.trim());
              }
            }
          }),
        ),
      );

      await logJob({ projectId, jobId }, "synthetic.plan.scene_dedupe", {
        similarity: env.SYNTHETIC_SCENE_DEDUPE_SIMILARITY,
        window: env.SYNTHETIC_SCENE_DEDUPE_WINDOW,
        visualBlocks: scenes.filter((s) => !!s).length,
        // How repetitive the plan was BEFORE this pass — the number to watch if
        // the client reports repetition again. A high count here with a low
        // regenerated count means the cap bound.
        repeatsDetected: flaggedTotal,
        regenerated: dedupeRegenerated,
        regenFailed: dedupeFailed,
        chains: chains.size,
      });
      if (flaggedTotal > repeats.length) {
        await logJob({ projectId, jobId }, "synthetic.plan.scene_dedupe.capped", {
          note:
            "more repeated scenes than SYNTHETIC_SCENE_DEDUPE_MAX_REGEN allows — " +
            "the overflow keeps its original prompt",
          detected: flaggedTotal,
          regenerated: repeats.length,
          skipped: flaggedTotal - repeats.length,
          maxRegen: env.SYNTHETIC_SCENE_DEDUPE_MAX_REGEN,
        });
      }
    }
  }

  // FINAL split_2 DURATION cap. `ensureMinSplit2` above can promote an image to
  // split_2 AFTER the early cap ran, and split_2 is exempt from splitByDuration,
  // so a promoted long block would otherwise hold beside the presenter past the
  // cap. Re-run the cap here — a promoted split_2 that fits stays untouched; one
  // over the cap is carved (first sentence stays split_2, rest → image). Runs
  // after the distinct-scene pass so no later pass can re-lengthen a split_2.
  await runSplit2DurationCap("final");

  // ZERO-WINDOW GUARD (avatar-bearing blocks). An avatar / split_2 block renders
  // via HeyGen Avatar III, which lip-syncs to an audio slice cut from the master
  // voiceover across [startTime, endTime]. If that window is degenerate
  // (endTime <= startTime + a hair), the slice is empty and Avatar III has NO
  // script fallback — the avatar job fails hard (observed: a split_2 with
  // start_time == end_time == 178.08). Such a block can't be a talking head:
  //   - split_2: demote to a still IMAGE (needs no audio); the block's
  //     illustrative prompt already describes a frame.
  //   - full avatar: it has no visual prompt to fall back to, so DROP it and
  //     absorb its (≤0.2s) window + script into a neighboring block — prefer an
  //     avatar neighbor so the words still play over a talking head. Only when
  //     the plan has no neighbor at all is the block kept and logged.
  {
    const AVATAR_MIN_WINDOW = 0.2; // seconds; below this the audio slice is unusable
    let demotedZeroWindow = 0;
    const drop = new Set<number>();
    for (let i = 0; i < planned.length; i++) {
      const p = planned[i];
      const window = p.endTime - p.startTime;
      if (window > AVATAR_MIN_WINDOW) continue;

      // ABSORB FIRST, for EVERY block type (widened 2026-07-31). Previously only
      // 'avatar' was absorbed and a degenerate image/ai_clip was left in place —
      // where the legacy path's Math.max(0.5, …) floor then gave it 0.5s of
      // duration it did not occupy. Eleven such blocks put a project 5.5s over
      // its voiceover and the render route refused it. A block with no spoken
      // window has nothing to show and nothing to say: fold it into a neighbour.
      let prevIdx = i - 1;
      while (prevIdx >= 0 && drop.has(prevIdx)) prevIdx--;
      const prev = prevIdx >= 0 ? planned[prevIdx] : null;
      const next = i + 1 < planned.length ? planned[i + 1] : null;
      // Prefer a same-type neighbour so a talking head's words stay over a
      // talking head; otherwise either neighbour will do.
      const into =
        (prev?.blockType === p.blockType ? prev : null) ??
        (next?.blockType === p.blockType ? next : null) ??
        prev ?? next;

      if (into) {
        // Extend the absorber's spoken window over the dropped block's window so
        // the timeline stays continuous, and carry the script so the review
        // screen still shows those words under the block that now covers them.
        if (into === prev) {
          into.endTime = Math.max(into.endTime, p.endTime);
          into.script = [into.script, p.script].filter((s) => s?.trim()).join(" ");
          if (p.charEnd !== undefined) into.charEnd = p.charEnd;
        } else {
          into.startTime = Math.min(into.startTime, p.startTime);
          into.script = [p.script, into.script].filter((s) => s?.trim()).join(" ");
          if (p.charStart !== undefined) into.charStart = p.charStart;
        }
        into.duration = into.endTime - into.startTime;
        drop.add(i);
        await logJob({ projectId, jobId }, "synthetic.plan.zero_window_absorbed", {
          position: p.position, blockType: p.blockType,
          startTime: p.startTime, endTime: p.endTime,
          intoPosition: into.position, intoBlockType: into.blockType,
          script: (p.script ?? "").slice(0, 80),
        });
        continue;
      }

      // No neighbour at all (single-block plan). An avatar-bearing block still
      // can't render — Avatar III lip-syncs to an audio slice and has no script
      // fallback — so demote split_2 to a still and surface a lone avatar.
      if (p.blockType === "split_2") {
        p.blockType = "image";
        p.animationPrompt = null;
        p.avatarModel = null;
        demotedZeroWindow++;
      } else if (p.blockType === "avatar") {
        await logJob({ projectId, jobId }, "synthetic.plan.avatar_zero_window", {
          position: p.position, startTime: p.startTime, endTime: p.endTime,
          script: (p.script ?? "").slice(0, 80),
        });
      }
    }
    if (drop.size > 0) {
      planned = planned.filter((_, i) => !drop.has(i));
      planned.forEach((p, i) => { p.position = i; });
    }
    if (demotedZeroWindow > 0) {
      await logJob({ projectId, jobId }, "synthetic.plan.zero_window_split2_demoted", {
        count: demotedZeroWindow, minWindowSeconds: AVATAR_MIN_WINDOW,
      });
    }
  }

  // MOTION FOR EVERY CLIP, WRITTEN FROM ITS OWN NARRATION (client 2026-08-25
  // via Joey: "the clips ... are very random and do not match at all").
  //
  // Runs LAST of the content passes, and that position is the point of it: by
  // here the block types are final (both promotion passes and the duration
  // quota have run) and the scenes are final (the second-visual and scene-dedupe
  // regenerations have run), so every ai_clip that will actually ship is visible
  // and every one of them is matched against the scene it will really show.
  //
  // Before this pass, a promoted block reached the worker with animation_prompt
  // NULL and got a generic fallback picked by a regex -- motion unrelated to the
  // line being spoken over it. See generateAnimationPrompts.
  //
  // Non-fatal by construction: a block the model skips keeps its null and the
  // worker's fallback still covers it, so a Gemini outage degrades the clips
  // rather than failing a plan that is otherwise complete.
  {
    const needMotion = planned
      .map((p, i) => ({ p, i }))
      .filter(
        ({ p }) =>
          p.blockType === "ai_clip" &&
          !(p.animationPrompt ?? "").trim() &&
          !!(p.imagePrompt ?? "").trim() &&
          !!(p.script ?? "").trim(),
      );
    if (needMotion.length > 0) {
      const filled = await generateAnimationPrompts({
        projectId,
        jobId,
        basePrompt,
        blocks: needMotion.map(({ p, i }) => ({
          i,
          script: p.script,
          imagePrompt: p.imagePrompt as string,
        })),
      });
      let written = 0;
      for (const { p, i } of needMotion) {
        const motion = filled.get(i);
        if (motion) {
          p.animationPrompt = motion;
          written++;
        }
      }
      const clipBlocks = planned.filter((p) => p.blockType === "ai_clip").length;
      await logJob({ projectId, jobId }, "synthetic.plan.animation_prompts_filled", {
        clipBlocks,
        missingBefore: needMotion.length,
        written,
        // Non-zero means that many clips still ship on the worker's generic
        // fallback -- the metric to watch if the client reports mismatched
        // footage again.
        stillMissing: needMotion.length - written,
      });
    }
  }

  // ---- FINAL PLAN VALIDATION -------------------------------------------
  // The last line of defence, and the alarm that was missing when a plan
  // reached the review screen ~725s behind its own audio with one sentence
  // fanned across the final 12 minutes. Both checks are on the PLAN, before
  // a single image is paid for.
  {
    const timelineDuration = planned.reduce((s, p) => s + (Number(p.duration) || 0), 0);
    // 1) Total must match the voiceover. The render route enforces ±3s; we use
    //    a tighter bound here so a plan can never be persisted that the render
    //    route would later refuse — the operator sees the real cause instead of
    //    a duration-arithmetic complaint after every asset has been generated.
    const PLAN_DURATION_TOLERANCE = 1.5;
    if (voiceoverDuration > 0 && Math.abs(timelineDuration - voiceoverDuration) > PLAN_DURATION_TOLERANCE) {
      throw new Error(
        `buildSyntheticTimeline: planned timeline ${timelineDuration.toFixed(1)}s does not ` +
          `match voiceover ${voiceoverDuration.toFixed(1)}s ` +
          `(delta ${(timelineDuration - voiceoverDuration).toFixed(1)}s, ${planned.length} blocks)`,
      );
    }
    // 2) No block may survive the carve passes at an impossible length. By
    //    this point splitByDuration has carved visuals to
    //    SYNTHETIC_BLOCK_SPLIT_THRESHOLD, split_2 is capped by
    //    SYNTHETIC_SPLIT2_MAX_SECONDS, and an avatar part is capped at
    //    AVATAR_PART_MAX_SECONDS — so anything far past a minute means a pass
    //    was skipped or a block escaped one.
    //
    //    This is a backstop, NOT the coverage guard: a block that swallowed
    //    the script has already been carved into many short slots by now and
    //    would sail through. That check lives at assembly time in the
    //    align-first branch above, before any carving happens.
    const durations = planned.map((p) => Number(p.duration) || 0).sort((a, b) => a - b);
    const longest = durations[durations.length - 1] ?? 0;
    const median = durations[Math.floor(durations.length / 2)] ?? 0;
    const ceiling = Math.max(90, median * 15);
    if (longest > ceiling) {
      throw new Error(
        `buildSyntheticTimeline: a single block spans ${longest.toFixed(1)}s after all ` +
          `pacing passes (median ${median.toFixed(1)}s, ceiling ${ceiling.toFixed(1)}s, ` +
          `${planned.length} blocks)`,
      );
    }
    await logJob({ projectId, jobId }, "synthetic.plan.validated", {
      blocks: planned.length,
      timelineDuration: Math.round(timelineDuration * 100) / 100,
      voiceoverDuration,
      longestBlockSeconds: Math.round(longest * 100) / 100,
    });
  }

  // Persist. Clear any prior plan first so retries don't accumulate.
  const sb = getServerSupabase();
  // BOTH tables, and timeline_items FIRST. Deleting only synthetic_segments
  // left the PREVIOUS plan's timeline_items behind as invisible orphans, and
  // nothing downstream could see them:
  //   - timeline_items.synthetic_segment_id is `on delete set null` (migration
  //     0024), so dropping the segments NULLED the orphans' link;
  //   - 0024's unique index is PARTIAL (where synthetic_segment_id is not null),
  //     so a null-linked orphan can never conflict;
  //   - maybeFinalizeSynthetic's already-materialized set is keyed on that same
  //     id, so it re-materializes the new plan alongside them.
  // The render gate, however, sums EVERY duration-bearing row — so a re-planned
  // project failed with "Timeline duration must match voiceover" by almost
  // exactly one whole voiceover. Observed 2026-08-15 on project 01bc9624
  // ("10 Chinese Utes"): 288 live rows = 1814.0s (a perfect match) plus 315
  // orphans = 1813.6s from a plan 8 hours earlier, summing to 3627.6s against a
  // 1814s voiceover.
  //
  // Ordered timeline_items -> synthetic_segments so the rows are gone before the
  // FK can null their link; if the second delete fails, the retry still sees a
  // clean timeline rather than a fresh batch of unreachable orphans.
  //
  // The wipe is UNFILTERED on purpose — it takes the sales-pitch row too, which
  // has no synthetic_segment_id. That row is rebuilt from projects.pitch_video_url
  // by ensurePitchTimelineItem, which maybeFinalizeSynthetic calls unconditionally
  // on every finalize (_shared.ts:258). Narrowing this delete to segment-linked
  // rows would reintroduce the orphan bug for exactly the rows that are hardest
  // to see.
  await sb.from("timeline_items").delete().eq("project_id", projectId);
  await sb.from("synthetic_segments").delete().eq("project_id", projectId);

  // EMPTY-SCENE REPAIR. The planner prompt ends "An empty imagePrompt is
  // INVALID output" and nothing checked it. When a visual block comes back with
  // no scene, composePrompt has nothing to lead with and returns the BARE
  // recurring world, so the row ships as e.g. "workshops, gun shops, estate
  // sales and the roads between them, present day, warm and plain" — a mood
  // with no subject, for a line that had one. The image processor's last-resort
  // fallback is the same base_prompt, so nothing downstream catches it either.
  //
  // Observed on a live plan for "Casual sellers have no idea the conversation is
  // even happening." Rare, which is why it went unnoticed: one dead block in a
  // few hundred is invisible in a log and obvious on screen.
  //
  // Repaired with the single-block path, which carries the full rule stack plus
  // the neighbouring lines — the same machinery the dedupe pass uses. A failure
  // here leaves the block exactly as it is now, so this can only improve it.
  {
    const empties = planned
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.blockType !== "avatar" && !(p.imagePrompt ?? "").trim());
    if (empties.length > 0) {
      const emptyLimit = makeLimit(5);
      let repaired = 0;
      await Promise.all(empties.map(({ p, i }) => emptyLimit(async () => {
        try {
          const r = await regenerateSegmentPrompt({
            projectId,
            jobId,
            script: p.script,
            basePrompt,
            blockType: p.blockType,
            language,
            surroundingScript: [planned[i - 1]?.script, planned[i + 1]?.script].filter(Boolean).join(" "),
          });
          p.imagePrompt = r.imagePrompt;
          p.shotType = null;
          if (p.blockType === "ai_clip") p.animationPrompt = r.animationPrompt;
          repaired++;
        } catch {
          // Non-fatal: the block keeps the bare-world prompt it already had.
        }
      })));
      await logJob({ projectId, jobId }, "synthetic.plan.empty_scene_repair", {
        found: empties.length,
        repaired,
        positions: empties.map(({ p }) => p.position),
      });
    }
  }

  // MATCH VERIFICATION — the last thing before the plan is written down.
  //
  // Every pass above tries to make each block's picture belong to its line.
  // None of them CHECKED. A block that showed folded blankets for a line about
  // how some guns looked passed every structural guard — it named a place, it
  // was not a duplicate, its shot type was valid — and was generated, animated
  // and rendered anyway. Measured on the bench, ~16% of blocks are still weak
  // or wrong after all the rules have had their say.
  //
  // So: judge each visual block against its own narration, and rewrite the ones
  // that fail, BEFORE anything is generated. The rewrite is kept only when it
  // judges better than what it replaces (a regeneration is another roll of the
  // same dice). Runs last so it sees the FINAL composed prompts — after the
  // splits, the dedupe regenerations and the empty-scene repair, which are the
  // passes that introduced the failures in the first place.
  if (getEnv().SYNTHETIC_MATCH_VERIFY_ENABLED) {
    const verifiable = planned
      .map((p, idx) => ({ p, idx }))
      .filter(({ p }) => p.blockType !== "avatar" && (p.imagePrompt ?? "").trim() && p.script.trim());
    if (verifiable.length > 0) {
      try {
        const { outcomes, judged, failedBatches } = await verifyAndRepair(
          verifiable.map(({ p, idx }) => ({
            i: idx,
            script: p.script,
            // Judge what will actually be STORED, base prompt and all.
            imagePrompt: composePrompt(basePrompt, p.imagePrompt, p.shotType) ?? p.imagePrompt ?? "",
          })),
          async (t, why) => {
            const seg = planned[t.i];
            const r = await regenerateSegmentPrompt({
              projectId,
              jobId,
              script: seg.script,
              basePrompt,
              blockType: seg.blockType,
              language,
              surroundingScript: [planned[t.i - 1]?.script, planned[t.i + 1]?.script].filter(Boolean).join(" "),
              // The judge's own complaint, fed back as the thing to fix. This is
              // the difference between a targeted rewrite and another blind roll.
              mismatchReason: why,
            });
            return r.imagePrompt;
          },
          {
            maxRepairs: getEnv().SYNTHETIC_MATCH_VERIFY_MAX_REPAIRS,
            alsoWeak: getEnv().SYNTHETIC_MATCH_VERIFY_STRICT,
          },
        );

        let repaired = 0;
        for (const o of outcomes) {
          if (!o.rewritten?.trim()) continue;
          planned[o.i].imagePrompt = o.rewritten;
          planned[o.i].shotType = null;
          repaired++;
        }
        await logJob({ projectId, jobId }, "synthetic.plan.match_verify", {
          judged: judged.length,
          failedBatches,
          flagged: outcomes.length,
          repaired,
          // Blocks the judge rejected that we could NOT improve. This is the
          // honest number to watch: it is what still ships wrong.
          unrepaired: outcomes.length - repaired,
          strict: getEnv().SYNTHETIC_MATCH_VERIFY_STRICT,
        });
      } catch (e) {
        // Never fail a plan over verification — an unverified plan is what we
        // shipped before this pass existed.
        await logJob({ projectId, jobId }, "synthetic.plan.match_verify.failed", {
          err: (e as Error).message?.slice(0, 200),
        });
      }
    }
  }

  // THE NARRATOR APPEARS IN THE STORY. Pick the few blocks whose still will be
  // generated with the project's avatar as an identity reference — narration in
  // the presenter's own voice, over a scene that already has a person in it.
  // Chosen across the finished plan so the count and spacing hold for the whole
  // video; keyed by `position` because that is what the persisted row carries.
  const characterEnv = getEnv();
  const characterBlockIndices = new Set<number>(
    characterEnv.SYNTHETIC_CHARACTER_BLOCKS_ENABLED
      ? selectCharacterBlocks(
          planned.map((p) => ({ blockType: p.blockType, script: p.script, imagePrompt: p.imagePrompt })),
          { max: characterEnv.SYNTHETIC_CHARACTER_BLOCKS_MAX },
        ).map((i) => planned[i].position)
      : [],
  );
  if (characterBlockIndices.size > 0) {
    await logJob({ projectId, jobId }, "synthetic.plan.character_blocks", {
      count: characterBlockIndices.size,
      max: characterEnv.SYNTHETIC_CHARACTER_BLOCKS_MAX,
      positions: [...characterBlockIndices].sort((a, b) => a - b),
    });
  }

  const rows = planned.map((p) => ({
    project_id: projectId,
    position: p.position,
    block_type: p.blockType,
    start_time: p.startTime,
    end_time: p.endTime,
    duration: p.duration,
    script: p.script,
    // Compose the shared base prompt in FRONT of the block's scene-specific
    // prompt so generation always carries the recurring world. avatar blocks
    // have no visual prompt (imagePrompt is null) and stay null. The SECOND
    // visual of a long sentence gets a "different angle" nudge so the two
    // frames covering one sentence aren't identical (both still derive from the
    // SAME full-sentence prompt — only the composition differs).
    image_prompt:
      p.blockType === "avatar"
        ? null
        : composePrompt(basePrompt, secondVisualPrompt(p.imagePrompt, p.secondVisual), p.shotType),
    animation_prompt: p.animationPrompt,
    // Which HeyGen model an avatar block renders with (red highlight ->
    // avatar_iv, orange -> avatar_iii). Null for every non-avatar block.
    avatar_model: p.blockType === "avatar" ? (p.avatarModel ?? "avatar_iv") : null,
    // Stash the video's recurring world on every row so the image processors
    // have a LAST-RESORT visual prompt that is on-topic — never the spoken
    // narration. A visual block should always carry a composed image_prompt
    // above, but if Gemini ever returns an empty scene AND there's no base, the
    // processor falls back to this instead of drawing the script verbatim.
    metadata: {
      base_prompt: basePrompt || null,
      // Which clip engine this block renders on (assignClipDurationQuota).
      // Only meaningful on ai_clip; null elsewhere. The processor reads this
      // rather than re-deriving the split, so a re-run of a single segment
      // keeps the engine the plan chose for it.
      clip_engine: p.blockType === "ai_clip" ? (p.clipEngine ?? "ltx") : null,
      // THE NARRATOR APPEARS IN THE STORY. True on the handful of blocks whose
      // still is generated with the project's avatar photo as an identity
      // reference. Decided HERE rather than in the image processor because the
      // count and the spacing are properties of the WHOLE plan — a processor
      // only ever sees one segment and could not enforce either.
      character_block: characterBlockIndices.has(p.position) || undefined,
    },
    status: "pending" as const,
  }));
  const { error } = await sb.from("synthetic_segments").insert(rows);
  if (error) throw new Error(`buildSyntheticTimeline persist: ${error.message}`);

  await logJob({ projectId, jobId }, "synthetic.plan.done", {
    segments: planned.length,
    byType: PLANNER_BLOCK_TYPES.reduce<Record<string, number>>((acc, t) => {
      acc[t] = planned.filter((p) => p.blockType === t).length;
      return acc;
    }, {}),
    voiceoverDuration,
    basePromptChars: basePrompt.length,
  });

  return planned;
}
