import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Project,
  ProjectId,
  ProjectStatus,
  GenerationOptions,
  ChannelUrl,
  NOT_RUNNING_STATES,
  type ProjectRepository,
  type ProjectListItem,
  type LandingCandidate,
  type ProjectState,
  type Tone,
  type BookType,
} from '@ebook/core';

interface ProjectRow {
  id: string;
  owner_id: string;
  channel_url: string;
  status: ProjectState;
  options: {
    bookTitle?: string;
    bookType?: BookType;
    targetPages: number;
    maxVideos: number;
    recipeCount?: number;
    tone: Tone;
    includeComments: boolean;
    includeIllustrations?: boolean;
    illustrationEveryPages?: number;
    landingPage?: boolean;
    landingCheckoutUrl?: string;
    landingCheckoutProductKey?: string;
    landingPriceCents?: number;
    landingCompareAtCents?: number;
    landingCurrency?: string;
    landingGuaranteeDays?: number;
    landingTemplateUrl?: string;
    landingTemplateId?: string;
    landingMode?: 'single' | 'triple';
    landingSiblings?: Array<{ projectId: string; priceCents?: number; checkoutUrl?: string }>;
    landingBundlePriceCents?: number;
    landingBundleCheckoutUrl?: string;
    landingAuthorPhotoPath?: string;
  };
  pending_counts: Record<string, number>;
  version: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export class SupabaseProjectRepository implements ProjectRepository {
  constructor(private readonly db: SupabaseClient) {}

  async findById(id: ProjectId): Promise<Project | null> {
    const { data, error } = await this.db.from('projects').select('*').eq('id', id.value).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? this.toDomain(data as ProjectRow) : null;
  }

  async save(project: Project): Promise<void> {
    // Optimistic concurrency on version; row trigger bumps version on write.
    const { error } = await this.db.from('projects').upsert({
      id: project.id.value,
      owner_id: project.ownerId,
      channel_url: project.channelUrl.raw,
      status: project.status.value,
      options: {
        ...(project.options.bookTitle ? { bookTitle: project.options.bookTitle } : {}),
        bookType: project.options.bookType,
        targetPages: project.options.targetPages,
        maxVideos: project.options.maxVideos,
        recipeCount: project.options.recipeCount,
        tone: project.options.tone,
        includeComments: project.options.includeComments,
        includeIllustrations: project.options.includeIllustrations,
        illustrationEveryPages: project.options.illustrationEveryPages,
        landingPage: project.options.landingPage,
        // Omitted rather than written as null when unset, matching bookTitle —
        // GenerationOptions treats an absent key and an empty string alike.
        ...(project.options.landingCheckoutUrl ? { landingCheckoutUrl: project.options.landingCheckoutUrl } : {}),
        // The store product behind that link, when we created it. Idempotency
        // depends on this surviving the round-trip — without it a second run
        // lists the same book on the store twice.
        ...(project.options.landingCheckoutProductKey
          ? { landingCheckoutProductKey: project.options.landingCheckoutProductKey }
          : {}),
        ...(project.options.landingPriceCents !== undefined
          ? { landingPriceCents: project.options.landingPriceCents }
          : {}),
        ...(project.options.landingCompareAtCents !== undefined
          ? { landingCompareAtCents: project.options.landingCompareAtCents }
          : {}),
        landingCurrency: project.options.landingCurrency,
        landingGuaranteeDays: project.options.landingGuaranteeDays,
        ...(project.options.landingTemplateUrl ? { landingTemplateUrl: project.options.landingTemplateUrl } : {}),
        // Which CLONED template this page is built from. Omitted when unset, so
        // a project on the built-in renderer carries no key at all — the same
        // shape every optional landing field above uses.
        ...(project.options.landingTemplateId ? { landingTemplateId: project.options.landingTemplateId } : {}),
        landingMode: project.options.landingMode,
        ...(project.options.landingSiblings.length > 0 ? { landingSiblings: project.options.landingSiblings } : {}),
        ...(project.options.landingBundlePriceCents !== undefined
          ? { landingBundlePriceCents: project.options.landingBundlePriceCents }
          : {}),
        ...(project.options.landingBundleCheckoutUrl
          ? { landingBundleCheckoutUrl: project.options.landingBundleCheckoutUrl }
          : {}),
        ...(project.options.landingAuthorPhotoPath
          ? { landingAuthorPhotoPath: project.options.landingAuthorPhotoPath }
          : {}),
      },
      pending_counts: project.pendingCounts,
      error: project.error ?? null,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
  }

  async listByOwner(ownerId: string): Promise<ProjectListItem[]> {
    const { data, error } = await this.db
      .from('projects')
      .select('id, channel_url, status, created_at')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      channelUrl: r.channel_url as string,
      status: r.status as ProjectState,
      createdAt: r.created_at as string,
    }));
  }

  async countRunningByOwner(ownerId: string): Promise<number> {
    // Count-only query (head: true) — no rows shipped, just the number running.
    // QUEUED is excluded: those are accepted but consume no worker capacity.
    const { count, error } = await this.db
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', ownerId)
      .not('status', 'in', `(${NOT_RUNNING_STATES.join(',')})`);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  async listQueuedByOwner(ownerId: string): Promise<ProjectListItem[]> {
    // Oldest first — queued books start in submission order.
    const { data, error } = await this.db
      .from('projects')
      .select('id, channel_url, status, created_at')
      .eq('owner_id', ownerId)
      .eq('status', 'QUEUED')
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      channelUrl: r.channel_url as string,
      status: r.status as ProjectState,
      createdAt: r.created_at as string,
    }));
  }

  async listLandingCandidates(ownerId: string, excludeProjectId: ProjectId): Promise<LandingCandidate[]> {
    // Joined against books because the picker needs a title and a cover — a
    // list of UUIDs is not something a user can choose from. The inner join is
    // deliberate: a COMPLETED project with no book row cannot be sold.
    const { data, error } = await this.db
      .from('projects')
      .select('id, channel_url, created_at, options, books!inner(title, cover_image_path)')
      .eq('owner_id', ownerId)
      .eq('status', 'COMPLETED')
      .neq('id', excludeProjectId.value)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    return (data ?? []).map((r) => {
      // Supabase types an embedded join as an array even when it is to-one.
      const rawBook = (r as { books: unknown }).books;
      const book = (Array.isArray(rawBook) ? rawBook[0] : rawBook) as
        | { title: string | null; cover_image_path: string | null }
        | undefined;
      // `options` was already being selected and then thrown away apart from the
      // title; the commerce fields ride along at no extra query cost.
      const options = (r as { options?: ProjectRow['options'] }).options;
      return {
        projectId: r.id as string,
        // The book's own title wins; the requested title is the fallback for
        // older rows where it was never written back.
        bookTitle: book?.title ?? options?.bookTitle ?? 'Untitled',
        coverImagePath: book?.cover_image_path ?? null,
        channelUrl: r.channel_url as string,
        createdAt: r.created_at as string,
        priceCents: options?.landingPriceCents ?? null,
        compareAtCents: options?.landingCompareAtCents ?? null,
        checkoutUrl: options?.landingCheckoutUrl ?? null,
        checkoutProductKey: options?.landingCheckoutProductKey ?? null,
      };
    });
  }

  async decrementPending(id: ProjectId, stage: string): Promise<number> {
    const { data, error } = await this.db.rpc('decrement_pending', { p_project: id.value, p_stage: stage });
    if (error) throw new Error(error.message);
    return (data as number | null) ?? 0;
  }

  async advanceStatusAtomic(id: ProjectId, from: ProjectState[], to: ProjectState): Promise<boolean> {
    // Single guarded UPDATE: only rows whose status is still in `from` are
    // changed, so exactly one of several racing callers can win the transition.
    const { data, error } = await this.db
      .from('projects')
      .update({ status: to, updated_at: new Date().toISOString() })
      .eq('id', id.value)
      .in('status', from)
      .select('id');
    if (error) throw new Error(error.message);
    return (data?.length ?? 0) > 0;
  }

  private toDomain(row: ProjectRow): Project {
    const url = ChannelUrl.create(row.channel_url);
    return Project.rehydrate(
      {
        ownerId: row.owner_id,
        channelUrl: url.isOk() ? url.value : ChannelUrl.create('https://youtube.com/@unknown').value,
        options: GenerationOptions.create(row.options),
        status: ProjectStatus.of(row.status),
        pendingCounts: row.pending_counts ?? {},
        version: row.version,
        ...(row.error ? { error: row.error } : {}),
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      },
      ProjectId.from(row.id),
    );
  }
}
