import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Result,
  type CopySlot,
  type LandingLayoutRepository,
  type LandingMode,
  type StoredLandingLayout,
} from '@ebook/core';
import { queryError } from './queryError';

interface LayoutRow {
  reference_url: string;
  mode: string;
  css: string;
  body_html: string;
  slots: CopySlot[] | null;
  input_hash: string | null;
}

/**
 * Layouts keyed by (reference URL, mode) and shared across every project.
 *
 * Shared on purpose: a layout is markup derived from a public page with all of
 * its text stripped out and replaced by slots, so it carries nothing belonging
 * to a particular account — and sharing is precisely what turns a per-book Opus
 * call into a one-off per template.
 */
export class SupabaseLandingLayoutRepository implements LandingLayoutRepository {
  constructor(private readonly db: SupabaseClient) {}

  async find(referenceUrl: string, mode: LandingMode): Promise<StoredLandingLayout | null> {
    const { data, error } = await this.db
      .from('landing_layouts')
      .select('reference_url, mode, css, body_html, slots, input_hash')
      .eq('reference_url', referenceUrl)
      .eq('mode', mode)
      .maybeSingle();
    if (error) throw queryError('landing_layouts', 'find', error);
    if (!data) return null;

    const row = data as LayoutRow;
    return {
      referenceUrl: row.reference_url,
      mode: row.mode as LandingMode,
      css: row.css,
      bodyHtml: row.body_html,
      slots: row.slots ?? [],
      inputHash: row.input_hash,
    };
  }

  async save(layout: StoredLandingLayout): Promise<Result<void>> {
    // Upsert on the natural key: two workers can finish deriving the same
    // layout at once, and the second simply replaces the first rather than
    // failing the whole generation over a duplicate.
    const { error } = await this.db.from('landing_layouts').upsert(
      {
        reference_url: layout.referenceUrl,
        mode: layout.mode,
        css: layout.css,
        body_html: layout.bodyHtml,
        slots: layout.slots,
        input_hash: layout.inputHash,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'reference_url,mode' },
    );
    if (error) return Result.fail(queryError('landing_layouts', 'save', error).message);
    return Result.ok();
  }
}
