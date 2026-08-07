import type { SupabaseClient } from '@supabase/supabase-js';
import { Result, type ObjectStorage } from '@ebook/core';

export class SupabaseStorageAdapter implements ObjectStorage {
  constructor(private readonly client: SupabaseClient) {}

  async put(bucket: string, path: string, data: Uint8Array, contentType: string): Promise<Result<{ path: string }>> {
    const { error } = await this.client.storage.from(bucket).upload(path, data, { contentType, upsert: true });
    return error ? Result.fail(error.message) : Result.ok({ path });
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

  async remove(bucket: string, path: string): Promise<Result<void>> {
    const { error } = await this.client.storage.from(bucket).remove([path]);
    return error ? Result.fail(error.message) : Result.ok();
  }
}
