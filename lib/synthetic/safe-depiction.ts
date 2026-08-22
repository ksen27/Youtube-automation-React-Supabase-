// CONTENT-REFUSAL PREVENTION for generated image/clip prompts.
//
// 69labs (and ai33 — same underlying model) refuse a generation outright on two
// distinct grounds, and the pipeline cannot tell them apart from the error text:
//   A. HARM — the prompt reads as force against a living subject, OR as a dead
//      one and the work done to it (below).
//   B. NAMED IP — the prompt names a brand, franchise, or character, or asks for
//      a logo/wordmark/packaging art to be reproduced (NAMED_IP_RULE).
// Either refusal comes back as CENSORED, which is TERMINAL everywhere in this
// pipeline (see isCensored in sixtynine-labs.ts): no other key and no other
// provider will accept the same text, so a refused block simply dies and waits
// for a human to edit it.
//
// The harm trigger is never a single banned word — it is the CONJUNCTION of
//   (a) a person directing FORCE at a living subject, and
//   (b) that subject showing DISTRESS.
// Observed 2026-08-21 on a cat-behaviour video:
//   "A human squirting a cat with a water bottle, and the cat flinching and
//    looking startled and confused."
// Both halves are innocuous alone; together a safety classifier scores them as
// animal cruelty regardless of the narration's educational intent, because the
// classifier only ever sees the picture description.
//
// A DEAD subject is refused on its own, with no act and no distress anywhere in
// the sentence. Observed 2026-08-22 on "How Inuit Survive a Polar Bear Attack"
// (12 of 325 blocks dead), and probed one prompt at a time against the live
// provider — refused on the left, what carries the same beat on the right:
//   "a polar bear feeding on a kill, ravens waiting for scraps"
//        -> "a polar bear standing over a dark shape half-buried in the snow,
//            ravens waiting a few metres away"                          PASS
//   "a hunter standing over a freshly hunted polar bear"
//        -> "a hunter kneeling beside a large white pelt spread flat on the
//            ice, tools laid out on a canvas sheet"                     PASS
//   "a hunter meticulously skinning a polar bear"
//        -> "hands stretching a large white pelt over a wooden drying frame"
//                                                                      PASS
//   "a raw polar bear liver, dark and dense, on a cold surface"
//        -> "a dark slab of raw meat on a cold metal tray"              PASS
//   "a sled laden with a fresh seal carcass"
//        -> "a sled loaded with canvas-wrapped bundles, tracks leading away"
//                                                                      PASS
// The pattern: the DEATH is refused, the WORK and its RESULTS are not. A pelt, a
// tool, a wrapped bundle, unnamed meat and an empty stretch of ice tell the same
// story and generate every time.
//
// NOT EVERY REFUSAL IS ABOUT THE TEXT. The same prompt submitted six times came
// back PASS PASS PASS CENSORED PASS CENSORED — borderline content is scored
// stochastically, so a block can die on an unlucky roll of a prompt that is
// otherwise fine. That is a retry problem, not a wording problem, and it is NOT
// what this module fixes: see the resubmit path in imageGenProcessor. Keep it in
// mind when reading a single CENSORED as proof that a prompt is unusable.
//
// Three layers defend against this, and this module holds two of them:
//   1. SAFE_DEPICTION_RULE + NAMED_IP_RULE — fed to Gemini by BOTH planner
//      prompt builders, so the risky prompt is never written in the first
//      place. Cheapest fix: nothing is submitted, nothing is spent.
//   2. softenImagePrompt — a deterministic pre-flight rewrite applied to every
//      prompt just before submit (generateImage), for what layer 1 misses on a
//      bad sampling roll. Free, offline, and testable.
//   3. (in imageGenProcessor) on a CENSORED refusal, ONE Gemini rewrite of the
//      segment's prompt and ONE resubmit, before failing the block.
// Layer 2 is deliberately CONSERVATIVE: it only rewrites patterns whose safe
// form is unambiguous, and reports anything else it recognises as `risky` so
// layer 3 can escalate to the model instead of guessing.

// ---------------------------------------------------------------------------
// Layer 1: the planner rule.
// ---------------------------------------------------------------------------

// Shared with SINGLE_SUBJECT_RULE et al. in planner.ts — used by BOTH the full
// planner prompt and the single-segment regenerator so a regenerated block is
// held to the same standard as a planned one.
export const SAFE_DEPICTION_RULE =
  "SAFE DEPICTION (critical — a prompt that breaks this rule is REFUSED by the " +
  "image provider and the block cannot be generated at all): NEVER describe a " +
  "person directing force at a living subject — no hitting, slapping, swatting, " +
  "kicking, shoving, grabbing, dragging, spraying or squirting at, restraining, " +
  "yelling at, or otherwise acting on an animal, a child, or another person. " +
  "NEVER describe a living subject as frightened, flinching, cowering, cringing, " +
  "crying, screaming, in pain, hurt, injured, or bleeding. This holds EVEN WHEN " +
  "the narration is about exactly that — an educational line about punishment, " +
  "conflict, injury, or fear is still refused when it is DRAWN literally. " +
  "Instead show the AFTERMATH or a NEUTRAL STAND-IN for the act: the subject's " +
  "calm body language a moment later, the object or tool at rest in the frame, " +
  "the two subjects apart in the same room, the empty space where it happened. " +
  "Example — for narration about squirting a cat with a water bottle, do NOT " +
  "write 'a person squirting a cat, the cat flinching'; write 'a cat sitting low " +
  "beside the sofa looking up across the room, a plastic spray bottle resting on " +
  "the coffee table in the soft-focus foreground'. Same story beat, no depicted " +
  "act, and it actually generates. " +
  // The DEAD-subject half, added 2026-08-22 after a hunting video lost 12 of 325
  // blocks. The rule above only ever spoke about a LIVING subject being acted on,
  // so the planner read "no cruelty" and then wrote "a hunter skinning a polar
  // bear" — every one of which was refused. Probed replacements are in the module
  // header comment.
  "THE SAME APPLIES TO A DEAD ONE. NEVER show an animal that has been killed or " +
  "the work done to it afterwards: no carcass, no kill, no dead, downed, or " +
  "freshly hunted animal, no body on the ground, no hunter or predator standing " +
  "over one, no skinning, gutting, butchering, cutting up, or 'processing the " +
  "animal', no organs, entrails, blood, or meat named as a particular animal's, " +
  "and no animal eating another. NEVER show a weapon being used or demonstrated " +
  "on anything — no thrust, strike, stab, swing, or aim, and no weapon put into " +
  "a child's hands. This holds EVEN WHEN the narration is entirely about the " +
  "hunt, the kill, or the butchering: it is refused every time it is DRAWN, and " +
  "a refused block shows the viewer nothing at all. " +
  "Show the WORK and its RESULTS instead, which is what the scene is really " +
  "about: the pelt or hide spread out, stretched on a drying frame, or folded in " +
  "a stack; the tools laid on a cloth, cleaned, or resting in a hand; the sled " +
  "and its wrapped bundles; meat as plain unnamed food on a board or tray; the " +
  "hunters' faces, hands, and breath in the cold; the tracks, the empty ice, the " +
  "birds waiting at a distance; the walk home. Write it in your own words, a " +
  "different angle each time — these are directions, not sentences to copy. " +
  // Refused 3 of 3 submits, the hardest block in the whole audit: "a visual
  // representation of a wild boar's reproductive organs, emphasising its high
  // fertility" (2026-08-22, feral-hog video). Anatomy is refused outright,
  // where every other family in this rule is merely likely to be.
  "AND NEVER DRAW ANATOMY. No reproductive organs, genitals, udders, internal " +
  "organs, cross-sections of a body, or a wound, cut, burn, or injury being " +
  "treated or shown. This is refused every single time, so a block written that " +
  "way is simply lost. When the narration is about breeding, birth, fertility, " +
  "or injury, show the EVIDENCE instead — a sow with a litter of piglets, a " +
  "nest of young, a crowded field, a family group; a bandaged arm, a first-aid " +
  "kit open on a table, the hands that did the work, a diagram in an open book.";

// The SECOND refusal family, and the one that actually cost us blocks in
// production. Observed 2026-08-22 on "17 Childhood Toys That Could Be Worth a
// Fortune Today": 12 of 230 blocks came back CENSORED, every single one of them
// naming a franchise or a trademark — "vintage Star Wars action figure", "1977
// Kenner Star Wars Early Bird Certificate Package", "Luke Skywalker … double-
// telescoping lightsaber", "first edition Pokémon trading card", "the unique
// font and colour scheme of its early logo". Nothing violent anywhere in them:
// gpt-image-2 refuses copyrighted characters, trademarks and logo reproduction
// on sight, and the whole niche (collectibles, toys, cards) is made of exactly
// that.
//
// The fix is NOT to drop the subject — the video is about those toys. It is to
// describe the OBJECT instead of the PROPERTY.
//
// Stripping the NAME is necessary but NOT sufficient, which is the part that is
// easy to get wrong. Probed against the live provider 2026-08-22, one prompt per
// line, everything else held constant:
//   CENSORED  "…action figure in a cream tunic, about three inches tall, a thin
//              extendable tube blade pulled out from its thicker handle…"
//   CENSORED  "…action figure in a cream tunic and brown boots, on a dusty
//              shelf…"                              <- costume alone still fails
//   PASS      "…action figure held between finger and thumb, a thin telescoping
//              plastic rod slid out of its raised fist…"  <- prop alone is fine
//   PASS      "…the underside of a small worn plastic toy figure … moulded
//              production lettering stamped into the plastic…"
//   PASS      "…sun-faded cardboard backing card with an empty yellowed blister
//              bubble, no printed artwork…"
//   PASS      "…hands sorting a shallow cardboard box of small worn plastic toy
//              figures…"
// So the classifier is matching the LIKENESS, not the string: a costume is
// enough to identify a character even with no name anywhere in the prompt, while
// the same figure described as a generic lump of worn plastic — plus its props,
// packaging, wear, and the hands holding it — generates every time. That is why
// the rule below bans the costume and pushes the story into the artefact.
export const NAMED_IP_RULE =
  "NO NAMED BRANDS OR CHARACTERS (critical — a prompt that breaks this rule is " +
  "REFUSED by the image provider and the block cannot be generated at all): " +
  "NEVER put a brand, company, studio, franchise, team, or character NAME in an " +
  "imagePrompt, and never ask for a logo, wordmark, trademark, printed packaging " +
  "text, card face, or box artwork to be REPRODUCED. Names of this kind are " +
  "refused on sight — Star Wars, Kenner, Luke Skywalker, Darth Vader, Pokémon, " +
  "Barbie, Hot Wheels, LEGO, Disney, Nintendo, Mario, Transformers, Marvel, " +
  "Coca-Cola, and every other name like them, including ones not listed here. " +
  "This holds EVEN WHEN the narration is entirely about that thing: the filter " +
  "only ever reads the picture description, so a line about a 1977 Kenner Star " +
  "Wars figure is still refused when the prompt calls it one. " +
  "REMOVING THE NAME IS NOT ENOUGH. Do not describe the CHARACTER either: no " +
  "costume, no robes/tunic/cape/armour/uniform, no helmet, mask, or hairstyle, " +
  "no signature colour scheme, no creature or species, no face. A description " +
  "specific enough for a viewer to say WHICH character it is gets refused just " +
  "as hard as the name does — 'an action figure in a cream tunic and brown " +
  "boots' is refused with no name anywhere in it. " +
  "Instead DESCRIBE THE ARTEFACT: it is a piece of moulded plastic, card, and " +
  "ink in someone's house, so shoot it as one. Say its size, its material, its " +
  "wear (paint chips, sun-fade, soft corners, yellowed tape, a price sticker), " +
  "the hands holding it, the packaging around it, the box or shelf it came out " +
  "of, the moulded lettering on its underside. Keep the figure itself GENERIC — " +
  "'a small worn plastic action figure', 'a stack of glossy trading cards' — and " +
  "let the era, the wear, and the setting carry the recognition. The viewer " +
  "knows exactly what they are looking at; the prompt never says. " +
  "Example of what to REMOVE — for narration about an early Kenner Star Wars " +
  "figure with a double-telescoping lightsaber, the prompt must not say 'Luke " +
  "Skywalker', 'Kenner', 'Star Wars', 'lightsaber', or 'in a cream tunic': that " +
  "is a name, a brand, a franchise, a trademarked prop, and a costume. What " +
  "survives is a small worn plastic figure with a thin telescoping rod — and " +
  "that generates. " +
  "Then choose your OWN angle on it. Some directions, as prompts to your " +
  "thinking rather than sentences to reuse: the object alone on a surface in " +
  "raking light; a hand presenting it to camera; the underside or the back; the " +
  "packaging with the object half out of it; several of them jumbled in a box or " +
  "lined up on a shelf; the empty space or the wrapping it just came out of; a " +
  "detail so tight it is mostly texture — scuffed plastic, a soft-cornered edge, " +
  "a faded sticker. Pick a different one each time and write it in your own " +
  "words, in the concrete detail of THIS block's narration. " +
  "The same applies to trading cards, comics, video-game and film characters, " +
  "sports teams, and album art: shoot the OBJECT, not the artwork on it — the " +
  "card's glossy stock and soft corners, a small stamp in its bottom-left " +
  "corner, a sleeve half-pulled off it, the yellowed tape on a cardboard mailer, " +
  "a sun-faded blister bubble with no printed art visible. Never ask for the " +
  "printed face, cover, or box art itself. " +
  "If a scene only works when you can tell what it is, pick a DIFFERENT detail " +
  "of the same beat: the collector's hands, the shelf, the packaging seam, the " +
  "price sticker, the storage box, the empty gap where it stood. " +
  // Without this, Gemini lifts the worked example word for word — every figure
  // block in a toy video came back as the same finger-and-thumb shot on the
  // first pass of this rule, which trades a refused block for a repetitive one.
  // (Hence the example above states only what to DELETE and leaves the picture
  // to be invented: there is no ready-made sentence left to copy.)
  "This rule is a METHOD, not text to copy. Your prompt must NOT reuse the " +
  "wording of any example or angle listed here — if a phrase of yours appears " +
  "above, replace it. Write a fresh, specific picture for THIS block.";

// ---------------------------------------------------------------------------
// Layer 2: the deterministic pre-flight softener.
// ---------------------------------------------------------------------------

// Verb STEMS, spelled without a trailing "e" (the inflection group below adds
// it back). Only verbs whose subject-acts-on-a-living-thing reading is the
// dominant one belong here: a stem that is usually benign ("pull", "carry")
// would cost more good prompts than it saves refused ones.
//
// "push" is deliberately ABSENT from this list and handled separately: a person
// pushing a child on a swing is a perfectly generatable picture, while pushing
// the cat away is not, so it is matched only with its "away" qualifier below.
const FORCE_STEMS = [
  "squirt", "spray", "hit", "strik", "slap", "smack", "swat", "kick", "punch",
  "shov", "yank", "drag", "chok", "strangl", "whip", "beat", "spank", "scruff",
  "grab", "restrain", "attack", "hurt", "harm", "injur", "threaten", "stab",
  "scold", "swing at", "lash out at",
];

// Suffixes covering the forms a picture prompt actually uses (gerund first —
// prompts are overwhelmingly participial: "A human squirting a cat…"), plus the
// consonant-doubling gerunds ("hitting", "grabbing") folded in as suffixes so
// the stem list can stay in plain dictionary form.
const VERB_SUFFIX = "(?:e|es|s|ed|ing|ping|ting|ging|ning|bing|ming)?";

// Living subjects a force verb must NOT be pointed at. Spraying the plants or
// hitting a nail is fine; the object is what makes the sentence a refusal.
//
// FARM animals are deliberately absent. A food or cooking video legitimately
// shows a raw chicken or a cut of pork, and the death rewrites below would turn
// those into "a dark slab of raw meat" — a worse picture for a prompt the
// provider was never going to refuse. Wildlife is the opposite case: a named
// wild animal beside a death word is refused nearly every time.
const LIVING = [
  "cat", "cats", "kitten", "kittens", "dog", "dogs", "puppy", "puppies", "pet",
  "pets", "animal", "animals", "bird", "birds", "horse", "horses", "rabbit",
  "rabbits", "hamster", "hamsters", "child", "children", "kid", "kids", "baby",
  "babies", "toddler", "toddlers", "infant", "infants", "boy", "boys", "girl",
  "girls", "man", "men", "woman", "women", "person", "people",
  // Wild animals — the subjects of hunting/wildlife videos. Multi-word entries
  // come FIRST so the alternation prefers "polar bear" over a bare "bear".
  "polar bear", "polar bears", "grizzly bear", "bear", "bears", "seal", "seals",
  "walrus", "walruses", "whale", "whales", "caribou", "reindeer", "deer",
  "moose", "elk", "wolf", "wolves", "fox", "foxes", "hare", "hares", "fish",
];

// Distress states, each mapped to a neutral body-language equivalent that keeps
// the frame readable. These are 1:1 word swaps — safe to apply unconditionally,
// because a picture of a wary cat tells the same story as a picture of a
// terrified one and is the only one of the two that generates.
const DISTRESS_SWAPS: Array<[RegExp, string]> = [
  [/\bflinch(?:es|ed|ing)?\b/gi, "leaning back"],
  [/\bcower(?:s|ed|ing)?\b/gi, "crouching low"],
  [/\bcring(?:e|es|ed|ing)\b/gi, "turning away"],
  [/\brecoil(?:s|ed|ing)?\b/gi, "leaning back"],
  [/\btrembl(?:e|es|ed|ing)\b/gi, "sitting very still"],
  [/\bshaking in fear\b/gi, "sitting very still"],
  [/\bwhimper(?:s|ed|ing)?\b/gi, "quiet"],
  [/\byelp(?:s|ed|ing)?\b/gi, "alert"],
  [/\b(?:sob|sobs|sobbing|crying|weeping|wailing|screaming|shrieking)\b/gi, "wide-eyed"],
  [/\b(?:terrified|frightened|scared|afraid|fearful|panicked|petrified)\b/gi, "wary"],
  [/\bstartled\b/gi, "alert"],
  [/\bdistressed\b/gi, "unsettled"],
  [/\bin (?:pain|distress|fear)\b/gi, "very still"],
  // ADVERB + injury first: the bare swap below turns "a badly injured person's
  // arm" into "a badly RESTING person's arm", which is not English. Found
  // 2026-08-22 auditing a first-aid block on the survival-rules video.
  [/\b(?:badly|severely|seriously|critically|gravely|horribly)\s+(?:hurt|injured|wounded)\b/gi, "bandaged"],
  // "injured"/"wounded" attach to a NOUN ("an injured man"), where "resting"
  // reads wrong; "bandaged" keeps the first-aid scene legible and generates.
  [/\b(?:injured|wounded)\b/gi, "bandaged"],
  [/\b(?:hurt|bleeding|bruised)\b/gi, "resting"],
  [/\bcornered\b/gi, "tucked into the corner"],
];

const LIVING_ALT = LIVING.join("|");
const FORCE_ALT = FORCE_STEMS.map((s) => s.replace(/ /g, "\\s+")).join("|");
const DET = "(?:a|an|the|this|that|its|his|her|their)";

// Up to two adjectives between a determiner and the animal, so "a freshly
// killed LARGE POLAR bear" still resolves to the animal noun. Bounded rather
// than greedy: an unbounded run would swallow the rest of the clause and leave
// the rewritten sentence ungrammatical.
const ADJ = "(?:[a-z]+\\s+){0,2}";

// The DEAD-subject rewrites, each one the replacement verified against the live
// provider (module header). Unlike the distress swaps these consume a whole noun
// phrase, so every replacement is written to slot into the sentence where the
// phrase stood: "a ritual over <a killed polar bear>" becomes "a ritual over <a
// large pelt laid out on the ground>".
const DEATH_SWAPS: Array<[RegExp, string]> = [
  // One animal eating another — refused with no human anywhere in the frame.
  [
    new RegExp(
      `\\b(?:feeding on|feasting on|eating|devouring|tearing (?:into|at)|gnawing (?:on|at)|chewing on|scavenging(?: on| from)?)\\s+(?:${DET}\\s+)?(?:${ADJ})?(?:piece of meat|kill|prey|carcass|meat|flesh|remains|catch)\\b`,
      "gi",
    ),
    "standing over a dark shape",
  ],
  // "a (freshly) killed / dead / downed / hunted <animal>" — the body itself.
  // The animal noun is dropped, not kept: "a large bear pelt" reads as a
  // trophy skin, which is the thing the scene is actually about.
  [
    new RegExp(`\\b(${DET})\\s+(?:fresh(?:ly)?\\s+)?(?:killed|dead|slain|downed|hunted|butchered|lifeless)\\s+${ADJ}(?:${LIVING_ALT})\\b`, "gi"),
    "$1 large pelt laid out on the ground",
  ],
  // "processing the animal" as a trailing explanatory clause. BEFORE the general
  // butchery rule below, which would also match it ("animal" is in LIVING) and
  // produce a second copy of that rule's replacement in the same sentence.
  [/\b(?:processing|butchering|dressing|breaking down) (?:the|an|a) (?:animal|kill|body|carcass)\b/gi, "working with the hides"],
  // The butchery verbs, with the animal as their object.
  [
    new RegExp(`\\b(?:skinning|butchering|gutting|dressing|carving up|cutting up|slaughtering|processing)\\s+(${DET})\\s+${ADJ}(?:${LIVING_ALT})\\b`, "gi"),
    "working over $1 large pelt spread on the ground",
  ],
  // "(various) parts of a <animal> laid out" — the same scene, one step later.
  [new RegExp(`\\b(?:various\\s+)?parts of\\s+${DET}\\s+${ADJ}(?:${LIVING_ALT})\\b`, "gi"), "folded pelts and tools"],
  // A carcass by any name.
  [new RegExp(`\\b(${DET})\\s+(?:fresh(?:ly)?\\s+)?${ADJ}carcass(?:es)?\\b`, "gi"), "$1 canvas-wrapped bundle"],
  // Organ meat, named or attached to an animal. Plain "raw meat" is left alone.
  [
    new RegExp(`\\b(?:raw\\s+)?${ADJ}(?:liver|heart|kidneys?|lungs?|intestines|entrails|innards|organs?|blubber)\\b(?=[^.;]{0,30}\\b(?:${LIVING_ALT})\\b)|\\braw\\s+${ADJ}(?:liver|heart|kidneys?|lungs?|intestines|entrails|innards|organs?|blubber)\\b`, "gi"),
    "dark slab of raw meat",
  ],
  // Predation described in the abstract, which survives the rewrites above
  // because it names no meat and no body: "…standing over a dark shape,
  // demonstrating its powerful FEEDING BEHAVIOUR" was still refused.
  [/\b(?:powerful\s+)?(?:feeding|hunting|predatory|killing)\s+(?:behaviou?r|instinct|prowess|technique)s?\b/gi, "presence in the landscape"],
  // A weapon being USED rather than held. "a knife thrust" -> "a knife held ready".
  [/\b(knife|blade|spear|harpoon|axe|club)\s+(?:thrust|strike|stab|jab|blow|swing)\b/gi, "$1 held ready"],
  [/\b(?:thrusting|stabbing|jabbing|swinging|slashing|striking with)\s+(?:a|an|the|his|her|their)\s+(knife|blade|spear|harpoon|axe|club)\b/gi, "holding a $1 ready"],
];

// "<force-verb> <det> <living> with <det> <instrument>" — the exact shape of the
// reported refusal. The instrument phrase is captured up to the clause end so
// multi-word instruments ("plastic water bottle") survive.
const FORCE_WITH_INSTRUMENT_RE = new RegExp(
  `\\b(?:${FORCE_ALT})${VERB_SUFFIX}\\s+(?:at\\s+)?(${DET})\\s+(${LIVING_ALT})\\b\\s+with\\s+(${DET})\\s+([^,.;]+)`,
  "gi",
);

// Same, with no instrument: "shoving the dog", "scolding the child".
const FORCE_BARE_RE = new RegExp(
  `\\b(?:${FORCE_ALT})${VERB_SUFFIX}\\s+(?:at\\s+)?(${DET})\\s+(${LIVING_ALT})\\b`,
  "gi",
);

// "push(es|ing) <det> <living> away" — push only counts as force with the
// "away" qualifier (see FORCE_STEMS).
const PUSH_AWAY_RE = new RegExp(
  `\\bpush(?:es|ed|ing)?\\s+(${DET})\\s+(${LIVING_ALT})\\b\\s+away`,
  "gi",
);

// Harm nouns: refusable on their own, with no verb/object structure to parse.
const RESIDUAL_HARM_RE =
  /\b(?:violence|violent|abuse|abusing|abused|cruelty|beating|bloodied|corpse)\b/gi;

// Death words the rewrites above could not attach to a noun phrase they know how
// to replace — "the moment of the kill", "blood on the snow", "a skinned hide".
// Nothing here is rewritten: there is no single safe picture these turn into, so
// they only raise `risky`, which routes the prompt to the LLM rewrite instead of
// a guess. "dead" and "kill" need a neighbouring animal or body word to count,
// or every dead end and every kill switch would escalate.
const RESIDUAL_DEATH_RE = new RegExp(
  `\\b(?:carcass(?:es)?|entrails|innards|slaughter(?:ed|ing)?|butcher(?:ed|ing)?|skinned|gutted|disembowel\\w*|blood(?:y|ied)?|gore|gory)\\b` +
    `|\\b(?:dead|killed|kill|slain|dying)\\b(?=[^.;]{0,30}\\b(?:${LIVING_ALT}|body|bodies)\\b)` +
    `|\\b(?:${LIVING_ALT})\\b(?=[^.;]{0,30}\\b(?:dead|killed|kill|slain|dying)\\b)`,
  "gi",
);

// A force verb whose object the rewrites could NOT parse, but which still points
// at something alive — e.g. "squirting water at the cat from across the room"
// (a noun sits between the verb and the living object, so FORCE_BARE_RE misses).
// The living noun must come AFTER the verb: it has to be the OBJECT of the
// force. Matching in either direction would flag every benign prompt whose
// SUBJECT is a person ("A woman spraying the tomato plants"), and a false
// positive here spends a Gemini rewrite to churn a prompt that was already fine.
// The 40-char window keeps the verb and the object in one clause.
const RESIDUAL_FORCE_RE = new RegExp(
  `\\b(?:${FORCE_ALT})${VERB_SUFFIX}\\b[^.;]{0,40}?\\b(?:${LIVING_ALT})\\b`,
  "gi",
);

export interface SoftenResult {
  // The prompt to actually send. Equal to the input when nothing matched.
  prompt: string;
  // True when the text was rewritten.
  changed: boolean;
  // True when a harm signal SURVIVES the rewrite — i.e. this prompt is still a
  // refusal candidate and deserves an LLM rewrite rather than a resubmit.
  risky: boolean;
  // The specific fragments that matched, for the job log. Bounded so a long
  // prompt can't flood a log line.
  matches: string[];
}

/**
 * Rewrite the unambiguously-refusable parts of an image prompt into a picture
 * that tells the same story and actually generates.
 *
 * Applied to EVERY prompt just before submit, so it also covers callers that
 * never went through the planner (avatar B-roll, image-to-video). Idempotent:
 * running it on its own output is a no-op, which matters because the retry path
 * softens a prompt that may already have been softened.
 */
export function softenImagePrompt(input: string): SoftenResult {
  const matches: string[] = [];
  const note = (m: string) => {
    const t = m.trim();
    if (t && matches.length < 8 && !matches.includes(t)) matches.push(t);
  };

  let out = input;

  // 0) The DEAD subject, first: these consume whole noun phrases ("a killed
  // polar bear"), and running them after the force patterns would mean those
  // patterns matched against text that is about to be replaced anyway.
  for (const [re, replacement] of DEATH_SWAPS) {
    out = out.replace(re, (m, ...groups) => {
      note(m);
      // $1 is the determiner when the pattern captured one; the replacement
      // strings above are written to match their own capture count.
      return replacement.replace(/\$1/g, String(groups[0] ?? "").trim());
    });
  }

  // 1) The act, with its instrument: keep the instrument as a PROP the actor
  // holds and put physical distance between the two subjects. This preserves
  // what the shot is about (a person, a spray bottle, a cat, one room) while
  // removing the act itself.
  out = out.replace(FORCE_WITH_INSTRUMENT_RE, (m, det1, living, det2, instrument) => {
    note(m);
    return `holding ${det2} ${String(instrument).trim()}, standing a few feet from ${det1} ${living}`;
  });

  // 2) "push … away" before the bare pass, so its "away" is consumed rather
  // than left dangling on the rewritten clause.
  out = out.replace(PUSH_AWAY_RE, (m, det, living) => {
    note(m);
    return `standing apart from ${det} ${living}`;
  });

  // 3) The act with no instrument.
  out = out.replace(FORCE_BARE_RE, (m, det, living) => {
    note(m);
    return `standing near ${det} ${living}`;
  });

  // 4) The distress reaction. Done LAST: the force rewrites above match on the
  // original wording, and swapping "flinching" first would not change what they
  // match but would make the notes report the post-swap text.
  for (const [re, replacement] of DISTRESS_SWAPS) {
    out = out.replace(re, (m) => {
      note(m);
      return replacement;
    });
  }

  // Tidy the seams a rewrite can leave ("… , and the cat" is fine; ", ," is not).
  out = out.replace(/\s{2,}/g, " ").replace(/\s+,/g, ",").replace(/,\s*,/g, ",").trim();

  const residual = [
    ...(out.match(RESIDUAL_HARM_RE) ?? []),
    ...(out.match(RESIDUAL_FORCE_RE) ?? []),
    ...(out.match(RESIDUAL_DEATH_RE) ?? []),
  ];
  residual.slice(0, 4).forEach(note);

  return { prompt: out, changed: out !== input, risky: residual.length > 0, matches };
}

/**
 * Read-only check: does this prompt carry a harm signal at all? Used to decide
 * whether a prompt is worth an LLM rewrite BEFORE spending a generation on it.
 */
export function hasDepictionRisk(input: string): boolean {
  const r = softenImagePrompt(input);
  return r.changed || r.risky;
}
