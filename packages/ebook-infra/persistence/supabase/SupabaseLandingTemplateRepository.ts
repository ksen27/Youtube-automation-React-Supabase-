import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Result,
  type ExtractionReport,
  type LandingTemplateRepository,
  type LandingTemplateState,
  type PlaceholderEntry,
  type PlaceholderOverride,
  type RepeaterEntry,
  type ResponsiveRules,
  type StoredLandingTemplate,
  type TemplateAsset,
  type ThemeTokens,
  type TypographyTokens,
} from '@ebook/core';
import { queryError } from './queryError';

interface TemplateRow {
  id: string;
  owner_id: string;
  source_url: string;
  state: string;
  name: string | null;
  original_html_path: string | null;
  clean_html_path: string | null;
  css_bundle_path: string | null;
  placeholder_map: PlaceholderEntry[] | null;
  repeater_map: RepeaterEntry[] | null;
  theme_tokens: ThemeTokens | null;
  typography_tokens: TypographyTokens | null;
  responsive_rules: ResponsiveRules | null;
  baseline_shots: Array<{ width: number; storagePath: string }> | null;
  placeholder_overrides: PlaceholderOverride[] | null;
  extraction_report: ExtractionReport | null;
  failure_reason: string | null;
  pipeline_version: number;
  revision: number;
  captured_at: string | null;
}

interface AssetRow {
  content_hash: string;
  site_path: string;
  storage_path: string;
  content_type: string;
  byte_size: number;
  kind: string;
  source_url: string | null;
  rehosted: boolean;
}

const COLUMNS =
  'id, owner_id, source_url, state, name, original_html_path, clean_html_path, css_bundle_path, ' +
  'placeholder_map, repeater_map, theme_tokens, typography_tokens, responsive_rules, baseline_shots, ' +
  'placeholder_overrides, extraction_report, failure_reason, pipeline_version, revision, captured_at';

const EMPTY_THEME: ThemeTokens = {
  accentToken: null,
  accentValue: null,
  onAccentValue: null,
  isDark: false,
  rootTokens: {},
};

const EMPTY_TYPOGRAPHY: TypographyTokens = { heading: null, body: null, familiesUsed: [] };

const EMPTY_RESPONSIVE: ResponsiveRules = { widths: [], breakpoints: [], sections: [] };

/**
 * Cloned templates, scoped to the account that extracted them.
 *
 * The blobs are not here. A rendered DOM plus a full CSS bundle runs to
 * hundreds of KB, and this project already learned what a multi-hundred-KB
 * write does to one PostgREST request — the row carries storage pointers and
 * the bytes live in the `landing-assets` bucket.
 */
export class SupabaseLandingTemplateRepository implements LandingTemplateRepository {
  constructor(private readonly db: SupabaseClient) {}

  async findById(id: string): Promise<StoredLandingTemplate | null> {
    const { data, error } = await this.db.from('landing_templates').select(COLUMNS).eq('id', id).maybeSingle();
    if (error) throw queryError('landing_templates', 'findById', error);
    return data ? toDomain(data as unknown as TemplateRow) : null;
  }

  async findCurrent(
    ownerId: string,
    sourceUrl: string,
    pipelineVersion: number,
  ): Promise<StoredLandingTemplate | null> {
    const { data, error } = await this.db
      .from('landing_templates')
      .select(COLUMNS)
      .eq('owner_id', ownerId)
      .eq('source_url', sourceUrl)
      .eq('pipeline_version', pipelineVersion)
      // Newest revision first: a re-extraction writes a new revision rather
      // than overwriting, so the previous one stays available if the new
      // capture came back worse.
      .order('revision', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw queryError('landing_templates', 'findCurrent', error);
    return data ? toDomain(data as unknown as TemplateRow) : null;
  }

  async listByOwner(ownerId: string): Promise<StoredLandingTemplate[]> {
    const { data, error } = await this.db
      .from('landing_templates')
      .select(COLUMNS)
      .eq('owner_id', ownerId)
      .order('updated_at', { ascending: false });
    if (error) throw queryError('landing_templates', 'listByOwner', error);
    return ((data ?? []) as unknown as TemplateRow[]).map(toDomain);
  }

  async create(input: {
    id: string;
    ownerId: string;
    sourceUrl: string;
    pipelineVersion: number;
    revision: number;
  }): Promise<Result<void>> {
    const { error } = await this.db.from('landing_templates').insert({
      id: input.id,
      owner_id: input.ownerId,
      source_url: input.sourceUrl,
      pipeline_version: input.pipelineVersion,
      revision: input.revision,
      state: 'EXTRACTING' satisfies LandingTemplateState,
    });
    // 23505 = unique_violation. The row this job is creating is keyed by an id
    // the job itself carries, so a collision means THIS job already created it
    // and is being re-delivered — BullMQ retries this queue once, and a first
    // attempt that dies after the insert (a transient "too many connections" on
    // the storage write is the observed case) leaves its own row behind.
    //
    // Failing here turns a recoverable mid-run error into a terminal one and
    // strands the row at EXTRACTING forever, which is what the user sees as
    // "copy the site does nothing". Treating it as success lets the retry
    // continue and overwrite the row it owns.
    if (error && error.code !== '23505') {
      return Result.fail(queryError('landing_templates', 'create', error).message);
    }
    return Result.ok();
  }

  async save(template: StoredLandingTemplate): Promise<Result<void>> {
    const { error } = await this.db
      .from('landing_templates')
      .update({
        state: template.state,
        name: template.name,
        original_html_path: template.originalHtmlPath,
        clean_html_path: template.cleanHtmlPath,
        css_bundle_path: template.cssBundlePath,
        placeholder_map: template.placeholders,
        repeater_map: template.repeaters,
        theme_tokens: template.theme,
        typography_tokens: template.typography,
        responsive_rules: template.responsive,
        baseline_shots: template.baselineShots,
        extraction_report: template.report,
        failure_reason: template.failureReason,
        captured_at: template.capturedAt?.toISOString() ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', template.id);
    if (error) return Result.fail(queryError('landing_templates', 'save', error).message);
    return Result.ok();
  }

  async listAssets(templateId: string): Promise<TemplateAsset[]> {
    const { data, error } = await this.db
      .from('landing_template_assets')
      .select('content_hash, site_path, storage_path, content_type, byte_size, kind, source_url, rehosted')
      .eq('template_id', templateId);
    if (error) throw queryError('landing_template_assets', 'listAssets', error);
    return ((data ?? []) as unknown as AssetRow[]).map((row) => ({
      contentHash: row.content_hash,
      sitePath: row.site_path,
      storagePath: row.storage_path,
      contentType: row.content_type,
      byteSize: row.byte_size,
      kind: row.kind as TemplateAsset['kind'],
      sourceUrl: row.source_url,
      rehosted: row.rehosted,
    }));
  }

  async saveAssets(templateId: string, assets: TemplateAsset[]): Promise<Result<void>> {
    if (assets.length === 0) return Result.ok();
    const { error } = await this.db.from('landing_template_assets').upsert(
      assets.map((a) => ({
        template_id: templateId,
        content_hash: a.contentHash,
        site_path: a.sitePath,
        storage_path: a.storagePath,
        content_type: a.contentType,
        byte_size: a.byteSize,
        kind: a.kind,
        source_url: a.sourceUrl,
        rehosted: a.rehosted,
      })),
      { onConflict: 'template_id,site_path' },
    );
    if (error) return Result.fail(queryError('landing_template_assets', 'saveAssets', error).message);
    return Result.ok();
  }

  async saveOverrides(templateId: string, overrides: PlaceholderOverride[]): Promise<Result<void>> {
    const { error } = await this.db
      .from('landing_templates')
      .update({ placeholder_overrides: overrides, updated_at: new Date().toISOString() })
      .eq('id', templateId);
    if (error) return Result.fail(queryError('landing_templates', 'saveOverrides', error).message);
    return Result.ok();
  }

  async remove(id: string): Promise<Result<void>> {
    const { error } = await this.db.from('landing_templates').delete().eq('id', id);
    if (error) return Result.fail(queryError('landing_templates', 'remove', error).message);
    return Result.ok();
  }
}

function toDomain(row: TemplateRow): StoredLandingTemplate {
  return {
    id: row.id,
    ownerId: row.owner_id,
    sourceUrl: row.source_url,
    state: row.state as LandingTemplateState,
    name: row.name,
    originalHtmlPath: row.original_html_path,
    cleanHtmlPath: row.clean_html_path,
    cssBundlePath: row.css_bundle_path,
    placeholders: row.placeholder_map ?? [],
    repeaters: row.repeater_map ?? [],
    theme: row.theme_tokens ?? EMPTY_THEME,
    typography: row.typography_tokens ?? EMPTY_TYPOGRAPHY,
    responsive: row.responsive_rules ?? EMPTY_RESPONSIVE,
    baselineShots: row.baseline_shots ?? [],
    overrides: row.placeholder_overrides ?? [],
    report: row.extraction_report,
    failureReason: row.failure_reason,
    pipelineVersion: row.pipeline_version,
    revision: row.revision,
    capturedAt: row.captured_at ? new Date(row.captured_at) : null,
  };
}
