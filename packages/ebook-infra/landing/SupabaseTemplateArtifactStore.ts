import {
  Result,
  lostFamiliesOf,
  type CapturedAsset,
  type ObjectStorage,
  type Shot,
  type StoredArtifacts,
  type StoredLandingTemplate,
  type TemplateArtifactStore,
  type TemplateAsset,
  type TypographyTokens,
  type WebFontFetcher,
} from '@ebook/core';
import { AssetRehoster, LANDING_BUCKET } from './AssetRehoster';
import { bundleCss } from './CssBundler';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Stores a cloned template's bytes and makes the page self-contained.
 *
 * Everything here is sequencing rather than judgement: hash the assets, put
 * them somewhere, repoint every reference at where they went. It sits behind a
 * port so the extraction use case never learns about buckets or content types.
 */
export class SupabaseTemplateArtifactStore implements TemplateArtifactStore {
  private readonly rehoster: AssetRehoster;

  constructor(
    private readonly storage: ObjectStorage,
    private readonly fonts: WebFontFetcher,
  ) {
    this.rehoster = new AssetRehoster(storage);
  }

  async storeTemplate(input: {
    templateId: string;
    originalHtml: string;
    cleanHtml: string;
    css: string;
    baseUrl: string;
    assets: CapturedAsset[];
    baselineShots: Shot[];
    typography?: TypographyTokens | undefined;
  }): Promise<Result<StoredArtifacts>> {
    const originalPath = `${input.templateId}/original.html`;
    const putOriginal = await this.storage.put(
      LANDING_BUCKET,
      originalPath,
      encoder.encode(input.originalHtml),
      'text/html; charset=utf-8',
    );
    if (putOriginal.isFail()) return Result.fail(`Could not store the captured HTML: ${putOriginal.error}`);

    const rehosted = await this.rehoster.rehost(input.templateId, input.assets);
    if (rehosted.isFail()) return Result.fail(rehosted.error);
    const assetMap = AssetRehoster.mapOf(rehosted.value);

    // The template's real typefaces, licence-gated. A face that may not be
    // redistributed is not downloaded at all — not merely not deployed.
    const declaredFaces = /@font-face/i.test(input.css);
    const embedded = await this.fonts.embedFrom(input.css, input.baseUrl);
    const embeddedFonts = embedded.isOk() ? embedded.value : [];
    const fontFaceCss = embeddedFonts.map((f) => f.fontFaceCss).join('\n');
    const embeddedFamilies = [...new Set(embeddedFonts.map((f) => f.family))];

    const bundled = bundleCss({
      css: input.css,
      baseUrl: input.baseUrl,
      assetMap,
      fontFaceCss,
      embeddedFamilies,
      typography: input.typography,
    });

    // Judged on what the PAGE still asks for, not on whether any face embedded.
    // The old test — `fontFaceCss ? 'exact' : 'degraded'` — reported a perfect
    // clone when one of eight faces survived, so the seller was told the
    // typography matched while the headline had changed typeface.
    const measuredLoss = lostFamiliesOf(input.typography?.familiesUsed ?? [], embeddedFamilies);
    const lostFamilies = [...new Set([...measuredLoss, ...bundled.lostFamilies])];
    const fontFidelity: StoredArtifacts['fontFidelity'] =
      !declaredFaces && lostFamilies.length === 0 ? 'none' : lostFamilies.length === 0 ? 'exact' : 'degraded';

    const shotPaths: Array<{ width: number; storagePath: string }> = [];
    for (const shot of input.baselineShots) {
      const path = `${input.templateId}/baseline-${shot.width}.png`;
      const put = await this.storage.put(LANDING_BUCKET, path, Buffer.from(shot.dataBase64, 'base64'), 'image/png');
      if (put.isOk()) shotPaths.push({ width: shot.width, storagePath: path });
    }

    return Result.ok({
      originalHtmlPath: originalPath,
      cleanHtml: rewriteHtmlAssets(input.cleanHtml, assetMap, input.baseUrl),
      css: bundled.css,
      breakpoints: bundled.breakpoints,
      assets: rehosted.value,
      baselineShotPaths: shotPaths,
      fontFidelity,
      lostFamilies,
      unresolvedUrls: bundled.unresolved,
    });
  }

  async pruneAssets(input: {
    templateId: string;
    html: string;
    css: string;
    assets: TemplateAsset[];
  }): Promise<TemplateAsset[]> {
    const referenced = new Set<string>();
    for (const match of `${input.html}\n${input.css}`.matchAll(/assets\/[a-f0-9]{6,}\.[a-z0-9]{2,5}/gi)) {
      referenced.add(match[0]);
    }

    const kept: TemplateAsset[] = [];
    for (const asset of input.assets) {
      if (referenced.has(asset.sitePath)) {
        kept.push(asset);
        continue;
      }
      // Nothing points at it any more — most often because the node holding it
      // became {{BOOK_COVER}}. Deleting is the point: it is the template
      // owner's image and we have no reason to keep a copy.
      await this.storage.remove(LANDING_BUCKET, asset.storagePath);
    }
    return kept;
  }

  async storeParameterised(input: {
    templateId: string;
    html: string;
    css: string;
  }): Promise<Result<{ cleanHtmlPath: string; cssBundlePath: string }>> {
    const cleanHtmlPath = `${input.templateId}/template.html`;
    const cssBundlePath = `${input.templateId}/bundle.css`;

    const putHtml = await this.storage.put(
      LANDING_BUCKET,
      cleanHtmlPath,
      encoder.encode(input.html),
      'text/html; charset=utf-8',
    );
    if (putHtml.isFail()) return Result.fail(`Could not store the template markup: ${putHtml.error}`);

    const putCss = await this.storage.put(
      LANDING_BUCKET,
      cssBundlePath,
      encoder.encode(input.css),
      'text/css; charset=utf-8',
    );
    if (putCss.isFail()) return Result.fail(`Could not store the stylesheet: ${putCss.error}`);

    return Result.ok({ cleanHtmlPath, cssBundlePath });
  }

  async loadTemplate(template: StoredLandingTemplate): Promise<Result<{ html: string; css: string }>> {
    if (!template.cleanHtmlPath || !template.cssBundlePath) {
      return Result.fail('This template has no stored markup — re-extract it.');
    }
    const html = await this.storage.getBytes(LANDING_BUCKET, template.cleanHtmlPath);
    if (html.isFail()) return Result.fail(`Could not read the template markup: ${html.error}`);
    const css = await this.storage.getBytes(LANDING_BUCKET, template.cssBundlePath);
    if (css.isFail()) return Result.fail(`Could not read the template stylesheet: ${css.error}`);
    return Result.ok({ html: decoder.decode(html.value.bytes), css: decoder.decode(css.value.bytes) });
  }

  loadAssets(assets: TemplateAsset[]): Promise<Array<{ sitePath: string; bytes: Uint8Array; contentType: string }>> {
    return this.rehoster.load(assets);
  }

  async storePageHtml(pageId: string, html: string): Promise<Result<string>> {
    const path = `pages/${pageId}.html`;
    const put = await this.storage.put(LANDING_BUCKET, path, encoder.encode(html), 'text/html; charset=utf-8');
    if (put.isFail()) return Result.fail(`Could not store the page: ${put.error}`);
    return Result.ok(path);
  }

  async loadPageHtml(path: string): Promise<Result<string>> {
    const bytes = await this.storage.getBytes(LANDING_BUCKET, path);
    if (bytes.isFail()) return Result.fail(`Could not read the page: ${bytes.error}`);
    return Result.ok(decoder.decode(bytes.value.bytes));
  }
}

/**
 * Repoints every image in the markup at its local copy, and removes the ones
 * that have none.
 *
 * Removing rather than leaving a broken reference is deliberate. An `<img>`
 * still pointing at the template's origin means the published page loads it
 * from the site it was copied from — the owner sees the traffic, and can break
 * or swap the image at will.
 */
function rewriteHtmlAssets(html: string, map: Map<string, string>, baseUrl: string): string {
  const absolute = (raw: string): string | null => {
    try {
      return new URL(raw, baseUrl).href;
    } catch {
      return null;
    }
  };

  return (
    html
      // srcset first: it wins over src, so a rewritten src beside an untouched
      // srcset would still load the original image.
      .replace(/\s+srcset="[^"]*"/gi, '')
      .replace(/\s+sizes="[^"]*"/gi, '')
      .replace(/<img\b[^>]*>/gi, (tag) => {
        const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1] ?? '';
        if (!src || src.startsWith('data:')) return tag;
        const resolved = absolute(src);
        const local = resolved ? map.get(resolved) : undefined;
        if (!local) return '';
        return tag.replace(/\bsrc="[^"]*"/i, `src="${local}"`);
      })
      .replace(/style="([^"]*url\([^"]*)"/gi, (whole, style: string) =>
        whole.replace(
          style,
          style.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (u, _q: string, raw = '') => {
            const resolved = absolute(String(raw));
            const local = resolved ? map.get(resolved) : undefined;
            return local ? `url("${local}")` : 'none';
          }),
        ),
      )
  );
}
