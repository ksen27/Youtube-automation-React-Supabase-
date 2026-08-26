// Colour keys for labels, member avatars and board themes.
//
// Deliberately a fixed key set rather than free-form hex: every value here maps
// to classes built from the design tokens in app/globals.css, so a label stays
// legible on the app's dark surfaces and the board never drifts off-palette.
// Colours are stored by key in the DB (board_labels.color, board_members.color,
// boards.theme), which also means a palette tweak is a code change, not a data
// migration.

export const LABEL_COLORS = [
  "indigo",
  "violet",
  "cyan",
  "emerald",
  "amber",
  "rose",
  "sky",
  "slate",
] as const;

export type LabelColor = (typeof LABEL_COLORS)[number];

export function isLabelColor(value: string): value is LabelColor {
  return (LABEL_COLORS as readonly string[]).includes(value);
}

/** Chip/pill styling for a label. Falls back to slate for unknown keys. */
export const LABEL_CLASS: Record<LabelColor, string> = {
  indigo: "bg-brand-500/15 text-brand-300 border-brand-500/30",
  violet: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  cyan: "bg-accent-cyan/15 text-accent-cyan border-cyan-400/30",
  emerald: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  amber: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  rose: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  sky: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  slate: "bg-surface-hover text-fg-muted border-border-strong",
};

/** The solid bar shown on a card preview, where the name is not rendered. */
export const LABEL_BAR_CLASS: Record<LabelColor, string> = {
  indigo: "bg-brand-500",
  violet: "bg-violet-500",
  cyan: "bg-accent-cyan",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  sky: "bg-sky-500",
  slate: "bg-border-strong",
};

export function labelClass(color: string): string {
  return LABEL_CLASS[(isLabelColor(color) ? color : "slate") as LabelColor];
}

export function labelBarClass(color: string): string {
  return LABEL_BAR_CLASS[(isLabelColor(color) ? color : "slate") as LabelColor];
}

/** Avatar tint. Solid enough to read as an identity at 24px. */
export const AVATAR_CLASS: Record<LabelColor, string> = {
  indigo: "bg-brand-600 text-white",
  violet: "bg-violet-600 text-white",
  cyan: "bg-cyan-600 text-white",
  emerald: "bg-emerald-600 text-white",
  amber: "bg-amber-600 text-white",
  rose: "bg-rose-600 text-white",
  sky: "bg-sky-600 text-white",
  slate: "bg-surface-hover text-fg",
};

export function avatarClass(color: string): string {
  return AVATAR_CLASS[(isLabelColor(color) ? color : "slate") as LabelColor];
}

/**
 * Pick a stable colour for a new member from their name, so two people added in
 * a row don't both come out indigo. Deterministic — the same name always gets
 * the same tint, which makes avatars recognisable across boards.
 */
export function colorForName(name: string): LabelColor {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return LABEL_COLORS[hash % LABEL_COLORS.length];
}

/** Up to two letters, e.g. "Ada Lovelace" -> "AL", "sarah" -> "SA". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const BOARD_THEMES = ["indigo", "violet", "cyan", "emerald", "slate"] as const;
export type BoardTheme = (typeof BOARD_THEMES)[number];

export function isBoardTheme(value: string): value is BoardTheme {
  return (BOARD_THEMES as readonly string[]).includes(value);
}

/** Header wash for the board. Subtle — the cards are the content, not this. */
export const BOARD_THEME_CLASS: Record<BoardTheme, string> = {
  indigo: "from-brand-500/20 via-brand-500/5 to-transparent",
  violet: "from-violet-500/20 via-violet-500/5 to-transparent",
  cyan: "from-accent-cyan/20 via-accent-cyan/5 to-transparent",
  emerald: "from-emerald-500/20 via-emerald-500/5 to-transparent",
  slate: "from-surface-hover via-surface/40 to-transparent",
};

export function boardThemeClass(theme: string): string {
  return BOARD_THEME_CLASS[(isBoardTheme(theme) ? theme : "indigo") as BoardTheme];
}
