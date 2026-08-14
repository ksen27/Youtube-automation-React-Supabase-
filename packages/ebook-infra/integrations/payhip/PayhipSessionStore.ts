import { encryptJson, decryptJson } from '@/lib/crypto/secret-box';
import type { EbookSupabaseClient } from '../../persistence/supabase/SupabaseClientFactory';

/**
 * The stored Payhip browser session.
 *
 * Workers NEVER log in. A human logs in once in a visible browser
 * (`npm run payhip:connect`), the resulting Playwright storageState is
 * encrypted into `ebook.payhip_sessions`, and every headless run restores it
 * and only verifies it. See supabase/migrations/0034_payhip_session.sql for why
 * this lives in the database rather than in a file on disk.
 */

/** Playwright's storageState blob. Opaque here — only the browser layer reads it. */
export type PayhipStorageState = Record<string, unknown>;

export interface PayhipSessionRecord {
  storageState: PayhipStorageState | null;
  needsReauth: boolean;
  note: string | null;
  savedAt: Date | null;
}

/** One store, one session. Multi-account would key on a different label. */
export const DEFAULT_SESSION_LABEL = 'default';

export class PayhipSessionStore {
  constructor(
    private readonly db: EbookSupabaseClient,
    private readonly label: string = DEFAULT_SESSION_LABEL,
  ) {}

  async load(): Promise<PayhipSessionRecord | null> {
    const { data, error } = await this.db
      .from('payhip_sessions')
      .select('storage_state, needs_reauth, note, saved_at')
      .eq('label', this.label)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as {
      storage_state: string | null;
      needs_reauth: boolean;
      note: string | null;
      saved_at: string | null;
    };
    return {
      storageState: decryptJson<PayhipStorageState>(row.storage_state),
      needsReauth: row.needs_reauth,
      note: row.note,
      savedAt: row.saved_at ? new Date(row.saved_at) : null,
    };
  }

  /**
   * Whether a run can even be attempted. Deliberately does NOT decrypt or open a
   * browser — it answers the UI's "can I show this button" question, which is
   * asked on every page load.
   */
  async isConfigured(): Promise<boolean> {
    const { data, error } = await this.db
      .from('payhip_sessions')
      .select('storage_state, needs_reauth')
      .eq('label', this.label)
      .maybeSingle();
    if (error) return false;
    const row = data as { storage_state: string | null; needs_reauth: boolean } | null;
    return Boolean(row?.storage_state) && !row?.needs_reauth;
  }

  /**
   * Persist a session captured by the headed connect flow. Clears
   * `needs_reauth`: a fresh human login is exactly the thing that flag was
   * asking for, so the account goes straight back into service.
   */
  async saveConnected(storageState: unknown): Promise<void> {
    const { error } = await this.db.from('payhip_sessions').upsert(
      {
        label: this.label,
        storage_state: encryptJson(storageState),
        needs_reauth: false,
        note: null,
        saved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'label' },
    );
    if (error) throw new Error(error.message);
  }

  /**
   * Re-save cookies after a SUCCESSFUL run, so Payhip's sliding session window
   * resets. Without this the session lapses between listings and the operator is
   * asked to re-connect far more often than they should be. Deliberately does
   * not touch `needs_reauth` — this is a warm refresh, not a connect.
   */
  async refresh(storageState: unknown): Promise<void> {
    const { error } = await this.db
      .from('payhip_sessions')
      .update({
        storage_state: encryptJson(storageState),
        saved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('label', this.label);
    if (error) throw new Error(error.message);
  }

  /**
   * Flag the session as dead so the UI stops offering the button and tells the
   * operator to re-connect. Called only on a CONFIRMED login-page landing — a
   * timeout or a network blip must not strand a session that is actually fine.
   */
  async markNeedsReauth(note: string): Promise<void> {
    const { error } = await this.db
      .from('payhip_sessions')
      .update({
        needs_reauth: true,
        note: note.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('label', this.label);
    if (error) throw new Error(error.message);
  }
}
