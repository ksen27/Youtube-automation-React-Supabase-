import type { SupabaseClient } from '@supabase/supabase-js';
import { Result, type ObjectStorage } from '@ebook/core';

export class SupabaseStorageAdapter implements ObjectStorage {
  constructor(private readonly client: SupabaseClient) {}

  async put(bucket: string, path: string, data: Uint8Array, contentType: string): Promise<Result<{ path: string }>> {
    const { error } = await this.client.storage.from(bucket).upload(path, data, { contentType, upsert: true });
    return error ? Result.fail(error.message) : Result.ok({ path });
  }

  async signedUploadUrl(bucket: string, path: string): Promise<Result<{ url: string; token: string }>> {
    const { data, error } = await this.client.storage.from(bucket).createSignedUploadUrl(path);
    if (error || !data) return Result.fail(error?.message ?? 'could not create an upload URL');
    return Result.ok({ url: data.signedUrl, token: data.token });
  }

  async signedUrl(bucket: string, path: string, expiresInSeconds: number): Promise<Result<string>> {
    const { data, error } = await this.client.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
    if (error || !data) return Result.fail(error?.message ?? 'Failed to sign URL');
    return Result.ok(data.signedUrl);
  }

  async getDataUri(bucket: string, path: string): Promise<Result<string>> {
    const { data, error } = await this.client.storage.from(bucket).download(path);
    if (error || !data) return Result.fail(error?.message ?? 'Failed to download object');
    const bytes = Buffer.from(await data.arrayBuffer());
    const contentType = data.type || 'application/octet-stream';
    return Result.ok(`data:${contentType};base64,${bytes.toString('base64')}`);
  }

  async getBytes(bucket: string, path: string): Promise<Result<{ bytes: Uint8Array; contentType: string }>> {
    const { data, error } = await this.client.storage.from(bucket).download(path);
    if (error || !data) return Result.fail(error?.message ?? 'Failed to download object');
    return Result.ok({
      bytes: new Uint8Array(await data.arrayBuffer()),
      contentType: data.type || 'application/octet-stream',
    });
  }

  async exists(bucket: string, path: string): Promise<boolean> {
    // `list` is the only probe Supabase Storage offers that doesn't fetch the
    // object. It searches WITHIN a folder, so the path is split; `search` is a
    // substring filter, hence the exact-name check on the way out.
    const slash = path.lastIndexOf('/');
    const folder = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const { data, error } = await this.client.storage.from(bucket).list(folder, { limit: 100, search: name });
    if (error || !data) return false;
    return data.some((o) => o.name === name);
  }

  async remove(bucket: string, path: string): Promise<Result<void>> {
    const { error } = await this.client.storage.from(bucket).remove([path]);
    return error ? Result.fail(error.message) : Result.ok();
  }
}
