import { z } from 'zod';
import type { NextResponse } from 'next/server';
import { container, json, error, parseBody, handle, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

/**
 * A correction to what the annotation call decided.
 *
 * Kept as intent rather than as a node id: ids move when the source page
 * changes, but "this text is the hero subtitle" survives a re-extraction, which
 * is what lets review work be re-applied instead of redone.
 */
const OverridesDto = z.object({
  overrides: z
    .array(
      z.object({
        placeholder: z.string().max(120),
        action: z.enum(['relabel', 'keep', 'remove']),
        replacement: z.string().max(120).optional(),
        matchText: z.string().max(400).optional(),
      }),
    )
    .max(200),
});

// PORT NOTE: written as an explicit DISCRIMINATED union (the `ok` flag) rather
// than upstream's `{ res } | { c, template }` shape. That shape relies on
// `exactOptionalPropertyTypes`, which upstream's tsconfig sets and this repo's
// does not; without it `'res' in auth` leaves `auth.res` as possibly-undefined
// and every handler's return type widens to `NextResponse | undefined`.
type TemplateAuth =
  | { ok: false; res: NextResponse }
  | { ok: true; c: ReturnType<typeof container>; template: NonNullable<Awaited<ReturnType<ReturnType<typeof container>['repositories']['landingTemplates']['findById']>>> };

async function authorize(id: string): Promise<TemplateAuth> {
  const userId = ownerId();
  if (!userId) return { ok: false, res: error('Ebook owner is not configured', 500) };
  const c = container();
  const template = await c.repositories.landingTemplates.findById(id);
  if (!template) return { ok: false, res: error('Not found', 404) };
  if (template.ownerId !== userId) return { ok: false, res: error('Forbidden', 403) };
  return { ok: true, c, template };
}

/**
 * GET /api/landing-templates/:id — everything the review screen needs.
 *
 * The placeholder table with each node's ORIGINAL text is the important part:
 * it is how a user confirms the labelling without reading HTML, and the only
 * practical check on whether the model labelled the right nodes.
 */
export const GET = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.res;
  const { c, template } = auth;

  const assets = await c.repositories.landingTemplates.listAssets(template.id);

  return json({
    id: template.id,
    sourceUrl: template.sourceUrl,
    name: template.name,
    state: template.state,
    revision: template.revision,
    capturedAt: template.capturedAt?.toISOString() ?? null,
    failureReason: template.failureReason,
    theme: {
      accentToken: template.theme.accentToken,
      accentValue: template.theme.accentValue,
      onAccentValue: template.theme.onAccentValue,
      isDark: template.theme.isDark,
    },
    placeholders: template.placeholders.map((p) => ({
      placeholder: p.placeholder,
      kind: p.kind,
      maxChars: p.maxChars,
      originalText: p.originalText,
      // Replacing this node's text will drop inline markup it contained — an
      // accent span inside a heading, usually. Visible rather than discovered.
      losesInlineMarkup: p.hadInlineMarkup,
    })),
    repeaters: template.repeaters.map((r) => ({
      key: r.key,
      originalCount: r.originalCount,
      // False means the container is a hand-tuned row rather than a reflowing
      // grid, so the item count is fixed at the template's own.
      flexibleCount: r.flexibleCount,
      fields: r.fields,
    })),
    overrides: template.overrides,
    report: template.report,
    // Present even on a FAILED row: what the run worked out before it stopped
    // is the only way to tell a detection bug from a labelling one.
    detected: {
      repeaters: template.report?.detectedRepeaters ?? [],
      placeholders: template.placeholders.length,
    },
    responsive: { widths: template.responsive.widths, breakpoints: template.responsive.breakpoints },
    assets: {
      count: assets.length,
      bytes: assets.reduce((total, a) => total + a.byteSize, 0),
      degradedFonts: assets.filter((a) => a.kind === 'font' && !a.rehosted).length,
    },
  });
});

// PATCH /api/landing-templates/:id — record corrections to the labelling.
export const PATCH = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.res;
  const { c, template } = auth;

  const body = await parseBody(req, OverridesDto);
  if (!body.ok) return body.res;

  const saved = await c.repositories.landingTemplates.saveOverrides(template.id, body.data.overrides);
  if (saved.isFail()) return error(saved.error, 500);
  return json({ saved: true, appliedOnNextExtraction: true });
});

// DELETE /api/landing-templates/:id
export const DELETE = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.res;
  const { c, template } = auth;

  const removed = await c.repositories.landingTemplates.remove(template.id);
  if (removed.isFail()) return error(removed.error, 500);
  return json({ deleted: true });
});
