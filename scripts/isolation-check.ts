// DESCRIPTIVE lines — the ones that correctly show the topic object.
//
// The question is not whether the gun is in frame (it should be). It is whether
// the gun is SOMEWHERE, or floating on velvet for the three-hundredth time.
// Fixtures are real narration from the stored gun plan.
import { regenerateSegmentPrompt } from "@/lib/synthetic/planner";

const BASE = "small-town America, present day, plain and unglamorous";

const LINES = [
  "A Luger in original configuration is worth several times one that has been refinished.",
  "Matching numbers is the critical phrase. Every major component carries the last two digits of the serial number.",
  "The Marlin Model Thirty-Six was produced between nineteen thirty-six and nineteen forty-eight.",
  "A professional refinish on the wrong firearm can drop the realized price by sixty to eighty percent.",
  "Beyond matching numbers, the date of manufacture and the proof marks tell a story that moves the price.",
  "These rifles were common enough that nobody thought twice about them for fifty years.",
];

// The failure mode being measured: the object alone on a surface.
const ISOLATED_RE =
  /\b(resting|sitting|lying|laid|placed|displayed|propped|mounted|arranged)\s+(on|in|against|atop|inside)\b|\bproduct shot\b|\bagainst a (plain|neutral|dark|black|white)\b/i;
const PLACE_RE =
  /\b(shop|store|counter|market|fair|show|auction|workbench|bench|garage|workshop|kitchen|table|room|drawer|box|crate|car|truck|van|range|barn|attic|basement|booth|stall|cabinet|safe|rack|wall|porch|hallway)\b/i;
const PERSON_RE = /\b(person|man|woman|collector|owner|seller|buyer|dealer|customer|smith|someone)\b/i;

async function main() {
  let isolated = 0;
  let situated = 0;
  for (const script of LINES) {
    const r = await regenerateSegmentPrompt({
      projectId: "00000000-0000-0000-0000-000000000000",
      script,
      basePrompt: BASE,
      blockType: "image",
    });
    const p = r.imagePrompt.replace(/\. Setting:[\s\S]*$/i, "");
    const bare = ISOLATED_RE.test(p) && !PERSON_RE.test(p);
    const hasPlace = PLACE_RE.test(p) || PERSON_RE.test(p);
    if (bare && !hasPlace) isolated++;
    else situated++;
    console.log(`\n[${bare && !hasPlace ? "ISOLATED" : "SITUATED"}] ${script.slice(0, 88)}`);
    console.log(`   ${p}`);
  }
  console.log(`\nisolated ${isolated}/${LINES.length}   situated ${situated}/${LINES.length}`);
  console.log("(baseline on the live plans: ~80% isolated)");
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});
