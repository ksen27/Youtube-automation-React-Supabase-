import { ValueObject } from '../shared/ValueObject';
import { Result } from '../shared/Result';

export type ChannelRef =
  | { kind: 'id'; value: string } // UC...
  | { kind: 'handle'; value: string } // @handle
  | { kind: 'user'; value: string } // /user/name
  | { kind: 'custom'; value: string }; // /c/name

/** Parses and validates the many shapes of a YouTube channel URL. */
export class ChannelUrl extends ValueObject<{ raw: string; ref: ChannelRef }> {
  static create(raw: string): Result<ChannelUrl> {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      return Result.fail('Invalid URL');
    }
    if (!/(^|\.)youtube\.com$/.test(url.hostname) && url.hostname !== 'youtu.be') {
      return Result.fail('Not a YouTube URL');
    }
    const segments = url.pathname.split('/').filter(Boolean);
    const ref = ChannelUrl.parseRef(segments);
    if (!ref) return Result.fail('URL does not point to a channel');
    return Result.ok(new ChannelUrl({ raw, ref }));
  }

  private static parseRef(segments: string[]): ChannelRef | null {
    const [first, second] = segments;
    if (first?.startsWith('@')) return { kind: 'handle', value: first.slice(1) };
    if (first === 'channel' && second) return { kind: 'id', value: second };
    if (first === 'user' && second) return { kind: 'user', value: second };
    if (first === 'c' && second) return { kind: 'custom', value: second };
    return null;
  }

  get raw(): string {
    return this.props.raw;
  }
  get ref(): ChannelRef {
    return this.props.ref;
  }
}
