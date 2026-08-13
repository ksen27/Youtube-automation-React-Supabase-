import { describe, it, expect } from 'vitest';
import { ProxyHealth, classifyProxyFailure, maskProxy } from './proxyHealth';

const YT_DLP_407 =
  'WARNING: [youtube] <urlopen error Tunnel connection failed: 407 Proxy Authentication Required>. Retrying (1/3)...';

describe('classifyProxyFailure', () => {
  // yt-dlp wraps a 407 inside "Tunnel connection failed", which reads as a
  // connection problem. Auth is the specific — and actionable — cause.
  it('reads yt-dlp 407 stderr as auth, not unreachable', () => {
    expect(classifyProxyFailure(YT_DLP_407)).toBe('auth');
  });

  it('classifies an unreachable proxy', () => {
    expect(classifyProxyFailure('ERROR: unable to download: ECONNREFUSED')).toBe('unreachable');
  });

  it("classifies YouTube's bot gate as blocked, not a proxy fault", () => {
    expect(classifyProxyFailure('ERROR: Sign in to confirm you are not a bot')).toBe('blocked');
  });

  it('falls back to other', () => {
    expect(classifyProxyFailure('ERROR: Video unavailable')).toBe('other');
  });
});

describe('maskProxy', () => {
  // These strings land in job logs and in the project's error field, which is
  // persisted and rendered in the UI. Passwords must not ride along.
  it('strips credentials', () => {
    const masked = maskProxy('http://user:sup3rsecret@1.2.3.4:8000');
    expect(masked).toBe('http://1.2.3.4:8000');
    expect(masked).not.toMatch(/sup3rsecret|user/);
  });

  it('says nothing revealing for an unparseable entry', () => {
    expect(maskProxy('1.2.3.4:8000:user:pass')).toBe('proxy');
  });

  it('names the no-proxy case', () => {
    expect(maskProxy(undefined)).toBe('direct');
  });
});

describe('ProxyHealth', () => {
  const A = 'http://u:p@a:1';
  const B = 'http://u:p@b:2';

  it('quarantines a proxy that rejected credentials', () => {
    const health = new ProxyHealth(1000, () => 0);
    health.record(A, 'auth');
    expect(health.usable([A, B])).toEqual([B]);
  });

  // A flagged IP or a dropped connection is a per-request accident — sidelining
  // those would shrink a pool that is doing its job.
  it('does not quarantine blocked or unreachable proxies', () => {
    const health = new ProxyHealth(1000, () => 0);
    health.record(A, 'blocked');
    health.record(B, 'unreachable');
    expect(health.usable([A, B])).toEqual([A, B]);
  });

  it('lets a quarantine expire so a reset quota heals itself', () => {
    let now = 0;
    const health = new ProxyHealth(1000, () => now);
    health.record(A, 'auth');
    expect(health.usable([A])).toEqual([]);
    now = 1001;
    expect(health.usable([A])).toEqual([A]);
  });

  it('trusts a proxy again as soon as it succeeds', () => {
    const health = new ProxyHealth(10_000, () => 0);
    health.record(A, 'auth');
    health.clear(A);
    expect(health.usable([A])).toEqual([A]);
  });

  it('reports an empty pool when every proxy is quarantined', () => {
    const health = new ProxyHealth(1000, () => 0);
    health.record(A, 'auth');
    health.record(B, 'auth');
    expect(health.usable([A, B])).toEqual([]);
  });
});
