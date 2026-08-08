import { createHash } from 'node:crypto';
import { Result, type CapturedAsset, type ObjectStorage, type TemplateAsset } from '@ebook/core';

/** The bucket cloned template artifacts live in. Private, like `exports`. */
export const LANDING_BUCKET = 'ebook-landing-assets';

/** Extensions by content type, so a deployed file is served as what it is. */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'application/font-woff2': 'woff2',
};

/**
 * Stores a template's assets and gives each one a stable deployed path.
 *
 * Content-hashed rather than named after the source, for three reasons that all
 * happen to point the same way: identical assets across templates dedupe for
 * free, a deployed path leaks nothing about where the template came from, and a
 * re-extraction of an unchanged asset writes nothing.
 *
 * This is also what moves page weight OUT of the database row. v1 base64'd
 * every image into the HTML and wrote the lot into a single Postgres column,
 * which is what produced a 57014 statement timeout on one attempt and a
 * gateway 502 on the next.
 */
export class AssetRehoster {
  constructor(private readonly storage: ObjectStorage) {}

  /**
   * @param templateId Namespaces the storage path, so removing a template
   *   removes its objects without a reverse lookup.
   */
  async rehost(templateId: string, assets: CapturedAsset[]): Promise<Result<TemplateAsset[]>> {
    const stored: TemplateAsset[] = [];
    const seen = new Set<string>();

    for (const asset of assets) {
      const contentHash = createHash('sha1').update(Buffer.from(asset.bytes)).digest('hex').slice(0, 16);
      if (seen.has(contentHash)) continue;
      seen.add(contentHash);

      const contentType = normaliseContentType(asset.contentType, asset.sourceUrl);
      const extension = EXTENSIONS[contentType] ?? 'bin';
      const sitePath = `assets/${contentHash}.${extension}`;
      const storagePath = `${templateId}/${contentHash}.${extension}`;

      const put = await this.storage.put(LANDING_BUCKET, storagePath, asset.bytes, contentType);
      if (put.isFail()) {
        // One unreachable asset costs a decoration, not the template. The
        // stylesheet rewrite turns an unmapped url() into `none`, so the page
        // renders without it rather than reaching for the original server.
        continue;
      }

      stored.push({
        contentHash,
        sitePath,
        storagePath,
        contentType,
        byteSize: asset.bytes.byteLength,
        kind: asset.kind,
        sourceUrl: asset.sourceUrl,
        rehosted: true,
      });
    }

    return Result.ok(stored);
  }

  /** Source URL → deployed path, for rewriting the HTML and the CSS. */
  static mapOf(assets: TemplateAsset[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const asset of assets) {
      if (asset.sourceUrl && asset.rehosted) map.set(asset.sourceUrl, asset.sitePath);
    }
    return map;
  }

  /** Loads the bytes a deploy needs to ship alongside `index.html`. */
  async load(assets: TemplateAsset[]): Promise<Array<{ sitePath: string; bytes: Uint8Array; contentType: string }>> {
    const out: Array<{ sitePath: string; bytes: Uint8Array; contentType: string }> = [];
    for (const asset of assets) {
      if (!asset.rehosted) continue;
      const bytes = await this.storage.getBytes(LANDING_BUCKET, asset.storagePath);
      if (bytes.isFail()) continue;
      out.push({ sitePath: asset.sitePath, bytes: bytes.value.bytes, contentType: asset.contentType });
    }
    return out;
  }
}

/**
 * A CDN that serves `application/octet-stream` for a PNG would otherwise have
 * it deployed as `.bin`, which browsers refuse to render as an image. The URL's
 * own extension is the fallback signal.
 */
function normaliseContentType(declared: string, sourceUrl: string): string {
  const base = (declared.split(';')[0] ?? '').trim().toLowerCase();
  if (base && base !== 'application/octet-stream' && EXTENSIONS[base]) return base;

  const path = (() => {
    try {
      return new URL(sourceUrl).pathname.toLowerCase();
    } catch {
      return sourceUrl.toLowerCase();
    }
  })();

  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.avif')) return 'image/avif';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.woff')) return 'font/woff';
  return base || 'application/octet-stream';
}
