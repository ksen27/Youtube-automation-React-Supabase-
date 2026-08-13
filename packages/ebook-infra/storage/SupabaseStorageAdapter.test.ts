import { describe, it, expect } from 'vitest';
import { SupabaseStorageAdapter } from './SupabaseStorageAdapter';

interface ListCall {
  folder: string;
  search: string | undefined;
}

/**
 * Stubs the one Storage call `exists` makes, recording HOW it was asked — the
 * folder/search split is the part that breaks silently if it's wrong (a bad
 * split just reports "absent", which now triggers a pointless re-download).
 */
function fakeClient(objects: string[], error: { message: string } | null = null) {
  const calls: ListCall[] = [];
  const client = {
    storage: {
      from: () => ({
        list: async (folder: string, opts: { search?: string }) => {
          calls.push({ folder, search: opts?.search });
          if (error) return { data: null, error };
          const prefix = folder ? `${folder}/` : '';
          const names = objects
            .filter((o) => o.startsWith(prefix) && !o.slice(prefix.length).includes('/'))
            .map((o) => ({ name: o.slice(prefix.length) }));
          const search = opts?.search;
          return { data: search ? names.filter((n) => n.name.includes(search)) : names, error: null };
        },
      }),
    },
  };
  return { client, calls };
}

describe('SupabaseStorageAdapter.exists', () => {
  it('finds an object inside a folder', async () => {
    const { client, calls } = fakeClient(['proj-1/vid-1.mp3']);
    const adapter = new SupabaseStorageAdapter(client as never);
    expect(await adapter.exists('ebook-audio', 'proj-1/vid-1.mp3')).toBe(true);
    expect(calls).toEqual([{ folder: 'proj-1', search: 'vid-1.mp3' }]);
  });

  it('reports a missing object as absent', async () => {
    const { client } = fakeClient(['proj-1/other.mp3']);
    const adapter = new SupabaseStorageAdapter(client as never);
    expect(await adapter.exists('ebook-audio', 'proj-1/vid-1.mp3')).toBe(false);
  });

  // Jobs queued before audio keys were project-scoped still carry bare
  // `<youtubeId>.mp3` refs; those live at the bucket root.
  it('handles a bucket-root path with no folder', async () => {
    const { client, calls } = fakeClient(['dQw4w9WgXcQ.mp3']);
    const adapter = new SupabaseStorageAdapter(client as never);
    expect(await adapter.exists('ebook-audio', 'dQw4w9WgXcQ.mp3')).toBe(true);
    expect(calls).toEqual([{ folder: '', search: 'dQw4w9WgXcQ.mp3' }]);
  });

  // `search` is a substring filter, not an exact match — a listing containing
  // only `copy-of-vid-1.mp3` comes back non-empty for a search of `vid-1.mp3`,
  // so without the exact-name check the missing object would read as present.
  it('does not accept a substring match as the object', async () => {
    const { client } = fakeClient(['proj-1/copy-of-vid-1.mp3']);
    const adapter = new SupabaseStorageAdapter(client as never);
    expect(await adapter.exists('ebook-audio', 'proj-1/vid-1.mp3')).toBe(false);
  });

  it('treats a storage error as absent rather than throwing', async () => {
    const { client } = fakeClient([], { message: 'network down' });
    const adapter = new SupabaseStorageAdapter(client as never);
    expect(await adapter.exists('ebook-audio', 'proj-1/vid-1.mp3')).toBe(false);
  });
});
