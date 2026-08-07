import type { LandingMode } from '../project/GenerationOptions';

/**
 * The reference sales page each mode is shaped after.
 *
 * The client maintains one template per mode and they are not interchangeable:
 * the three-book reference sells three products from a "choose your level"
 * grid plus a bundle, which a one-book page has no use for.
 *
 * `single` has no default on purpose. One-book projects have always taken a
 * per-project reference URL, and defaulting them to the three-book site would
 * silently restyle every existing project the next time it regenerated.
 */
export const LANDING_TEMPLATE_DEFAULTS: Record<LandingMode, string | null> = {
  single: null,
  // Three books (The Mechanic's Bible, Smart Driver's Buying Bible, DIY Car
  // Repair Bible) plus a $47 complete bundle — the shape a `triple` page needs.
  triple: 'https://themechanicbible.com/',
};

/**
 * Which reference page this project's layout should follow.
 *
 * An explicit per-project URL wins, so a seller can point a page at their own
 * reference; otherwise the mode's default applies. Returns null when there is
 * no reference at all, which is the signal to use the built-in template.
 */
export function referenceUrlFor(mode: LandingMode, override?: string | undefined): string | null {
  const explicit = override?.trim();
  if (explicit) return explicit;
  return LANDING_TEMPLATE_DEFAULTS[mode];
}
