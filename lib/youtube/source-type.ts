// Source-type classifier. Tags a YouTube search candidate with one of four
// editorial buckets so the picker can show the user what kind of video
// they're about to confirm. Buckets are deliberately coarse — fine
// distinctions ("news_broadcast" vs "news_explainer") aren't useful for
// the user, who just needs to spot when six redundant news videos got
// surfaced for the same story.
//
// Buckets:
//   - interview   — host-led conversations (Jonathan Ross, Lorraine, etc.)
//                   Best variety per minute; rare and valuable.
//   - news        — news bulletins, explainer channels, "X sues Y" stories.
//                   Tend to repeat the same footage across channels.
//   - archival    — "best moments", "funniest", documentary cuts, dated
//                   highlights. Useful for atmospheric / context shots.
//   - other       — promotional uploads, channel-owned content, anything
//                   we couldn't classify confidently.
//
// Classification runs on (channel_title, video_title) at analyze time
// after rank+verify accept. No external API call — pure regex/text
// match. Order of rules matters: channel name beats title for shows
// with known formats (the Jonathan Ross channel uploads more than just
// interviews, but they're still interview-shaped), and inside titles,
// "interview" markers beat "news" markers when both appear.

export type SourceType = "interview" | "news" | "archival" | "other";

// Channels that publish interview / talk-show format almost exclusively.
// Add new entries as we encounter them — these are the strongest signal
// because the format is stable across uploads. Match is substring +
// case-insensitive against the channel title.
const INTERVIEW_CHANNEL_PATTERNS: string[] = [
  "jonathan ross",
  "graham norton",
  "lorraine",
  "this morning",
  "loose women",
  "the one show",
  "the late show",
  "the tonight show",
  "ellen",
  "james corden",
  "late late show",
  "andrew marr",
  "piers morgan",
  "good morning britain",
  "talk show",
];

// News / explainer-style channels. Many of these surface the same lawsuit
// or scandal story across uploads; flagging them lets the user see when
// the picker has surfaced too many redundant ones.
const NEWS_CHANNEL_PATTERNS: string[] = [
  "talktv",
  "bbc news",
  "sky news",
  "itv news",
  "channel 4 news",
  "celebrity news",
  "birmingham live",
  "express",
  "mirror",
  "metro",
  "the sun",
  "daily mail",
  "show love",
  "celebrity update",
  "celebrity today",
  "sportv star", // SportTV Star (typo-tolerant)
  "sporttv star",
  "star factor",
  "hollywood pashto", // local-language news aggregators
  "celebrity story",
  "celebrity news today",
  "uk - celebrity",
];

// Archival / highlights channels. Usually compilations of past appearances.
const ARCHIVAL_CHANNEL_PATTERNS: string[] = [
  "best moments",
  "top talent",
  "talent recap",
  "talent global",
  "viral feed",
  "got talent global",
  "replaytv",
  "replay tv",
];

// Title markers (used when channel signal is weak / unknown).
const INTERVIEW_TITLE_PATTERNS: RegExp[] = [
  /\binterview\b/i,
  /\btalks to\b/i,
  /\bin conversation\b/i,
  /\bsit down with\b/i,
  /\bjoins\b.*\bshow\b/i,
];

const NEWS_TITLE_PATTERNS: RegExp[] = [
  /\bsues?\b/i,
  /\bsettles?\b.*\b(lawsuit|legal|case)\b/i,
  /\bscandal\b/i,
  /\bcontroversy\b/i,
  /\bfired\b/i,
  /\baxed\b/i,
  /\baccused\b/i,
  /\bleaked\b/i,
  /\bbreaking\b/i,
  /\bexclusive\b/i,
  /\bwhy\s+(is|did|has)\b/i,
  /\bwhat (really )?happened\b/i,
];

const ARCHIVAL_TITLE_PATTERNS: RegExp[] = [
  /\bbest moments?\b/i,
  /\bfunniest\b/i,
  /\btop \d+\b/i,
  /\bhighlights?\b/i,
  /\bbest of\b/i,
  /\bmost\b.*\b(funny|hilarious|shocking)\b/i,
  /\b(19|20)\d{2}\b.*\b(throwback|archive|vintage)\b/i,
  /\bdocumentary\b/i,
  /\bcareer of\b/i,
  /\bbehind the scenes\b/i,
];

function matchAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  for (const n of needles) {
    if (h.includes(n)) return true;
  }
  return false;
}

function matchAnyRegex(haystack: string, patterns: RegExp[]): boolean {
  for (const re of patterns) {
    if (re.test(haystack)) return true;
  }
  return false;
}

export function classifySourceType(input: {
  channelTitle: string;
  videoTitle: string;
}): SourceType {
  const channel = (input.channelTitle ?? "").trim();
  const title = (input.videoTitle ?? "").trim();

  // Tier 1 — channel-based classification (strongest signal).
  // Interview channels first: a "best moments" upload on the Jonathan
  // Ross channel is still interview-shaped (clips from the show).
  if (matchAny(channel, INTERVIEW_CHANNEL_PATTERNS)) return "interview";
  if (matchAny(channel, ARCHIVAL_CHANNEL_PATTERNS)) return "archival";
  if (matchAny(channel, NEWS_CHANNEL_PATTERNS)) return "news";

  // Tier 2 — title-based classification.
  // Order matters: an "interview about a lawsuit" titled video should be
  // tagged interview, not news. So check interview patterns first.
  if (matchAnyRegex(title, INTERVIEW_TITLE_PATTERNS)) return "interview";
  if (matchAnyRegex(title, ARCHIVAL_TITLE_PATTERNS)) return "archival";
  if (matchAnyRegex(title, NEWS_TITLE_PATTERNS)) return "news";

  // Tier 3 — generic "news" channels by suffix. Many local/regional
  // outlets follow patterns like "X News Today", "X Live", "X Daily"
  // that our explicit list misses.
  const channelLower = channel.toLowerCase();
  if (/\bnews\b/.test(channelLower) || /\btoday\b/.test(channelLower) || /\blive\b/.test(channelLower)) {
    return "news";
  }

  // Default — couldn't classify. Picker shows "Other".
  return "other";
}
