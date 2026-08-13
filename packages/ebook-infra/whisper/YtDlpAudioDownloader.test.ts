import { describe, it, expect, vi } from 'vitest';
import { NonRetryableError, Result, type ObjectStorage } from '@ebook/core';
import { audioRefFor, YtDlpAudioDownloader } from './YtDlpAudioDownloader';
import { ProxyHealth } from '../net/proxyHealth';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '33333333-3333-4333-8333-333333333333';
const VIDEO_A = '22222222-2222-4222-8222-222222222222';
const VIDEO_B = '44444444-4444-4444-8444-444444444444';
const YOUTUBE_ID = 'dQw4w9WgXcQ';

describe('audioRefFor', () => {
  it('scopes the key to the project and video', () => {
    expect(audioRefFor({ youtubeId: YOUTUBE_ID, projectId: PROJECT_A, videoId: VIDEO_A })).toBe(
      `${PROJECT_A}/${VIDEO_A}.mp3`,
    );
  });

  // The original bug: the key was `<youtubeId>.mp3`, so every run of the same
  // video shared one object — and this stage DELETES the audio once transcribed.
  // A re-generate (or a second project on the same channel) deleted the file a
  // concurrent run still needed, which surfaced as "Object not found".
  it('gives two runs of the same youtube video distinct keys', () => {
    const a = audioRefFor({ youtubeId: YOUTUBE_ID, projectId: PROJECT_A, videoId: VIDEO_A });
    const b = audioRefFor({ youtubeId: YOUTUBE_ID, projectId: PROJECT_B, videoId: VIDEO_B });
    expect(a).not.toBe(b);
  });

  it('is stable for the same target, so a retry rebuilds the same key', () => {
    const target = { youtubeId: YOUTUBE_ID, projectId: PROJECT_A, videoId: VIDEO_A };
    expect(audioRefFor(target)).toBe(audioRefFor({ ...target }));
  });
});

const TARGET = { youtubeId: YOUTUBE_ID, projectId: PROJECT_A, videoId: VIDEO_A };
const PROXIES = ['http://u:secret@1.1.1.1:8000', 'http://u:secret@2.2.2.2:8000'];
const AUTH_ERROR = '<urlopen error Tunnel connection failed: 407 Proxy Authentication Required>';

const storage: ObjectStorage = {
  put: async () => Result.ok({ path: '' }),
  signedUrl: async () => Result.ok(''),
  getDataUri: async () => Result.fail('unused'),
  getBytes: async () => Result.fail('unused'),
  exists: async () => false,
  remove: async () => Result.ok(),
};

/** yt-dlp is never actually spawned — each attempt fails with the given stderr. */
function downloader(errors: string[], health: ProxyHealth, proxies: string[] = PROXIES) {
  const d = new YtDlpAudioDownloader(storage, 'yt-dlp', undefined, undefined, proxies, undefined, undefined, health);
  let attempt = 0;
  const runs: Array<string | undefined> = [];
  // `runYtDlp` is private to callers, but it is the seam between this class and
  // the network — stubbing it exercises the pool logic without a real download.
  const spy = vi
    .spyOn(d as unknown as { runYtDlp: (id: string, out: string, proxy?: string) => Promise<void> }, 'runYtDlp')
    .mockImplementation(async (_id, _out, proxy) => {
      runs.push(proxy);
      throw new Error(errors[Math.min(attempt++, errors.length - 1)]!);
    });
  return { d, runs, spy };
}

describe('YtDlpAudioDownloader proxy handling', () => {
  it('stops non-retryably when every proxy rejects authentication', async () => {
    const { d } = downloader([AUTH_ERROR, AUTH_ERROR], new ProxyHealth(60_000, () => 0));
    await expect(d.downloadAudio(TARGET)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('reports every proxy and its failure kind, with credentials masked', async () => {
    const { d } = downloader([AUTH_ERROR, AUTH_ERROR], new ProxyHealth(60_000, () => 0));
    const err = await d.downloadAudio(TARGET).then(
      () => null,
      (e: Error) => e,
    );
    if (!err) throw new Error('expected the download to throw');
    expect(err.message).toMatch(/auth: 2/);
    expect(err.message).toMatch(/1\.1\.1\.1:8000/);
    expect(err.message).toMatch(/2\.2\.2\.2:8000/);
    expect(err.message).not.toMatch(/secret/); // never leak the proxy password
  });

  // Only an all-auth pool is hopeless. A blocked IP alongside it is ordinary,
  // and BullMQ's retry (on a rotated start proxy) is the right response.
  it('stays retryable when the failures are not all auth', async () => {
    const { d } = downloader([AUTH_ERROR, 'Sign in to confirm you are not a bot'], new ProxyHealth(60_000, () => 0));
    const r = await d.downloadAudio(TARGET);
    expect(r.isFail()).toBe(true);
  });

  it('skips a quarantined proxy on the next video instead of re-trying it', async () => {
    const health = new ProxyHealth(60_000, () => 0);
    const first = downloader([AUTH_ERROR, 'Sign in to confirm you are not a bot'], health);
    await first.d.downloadAudio(TARGET);
    expect(first.runs).toHaveLength(2); // both tried the first time

    // Second video: the auth-rejecting proxy is sidelined, so only the other is tried.
    const second = downloader(['Sign in to confirm you are not a bot'], health);
    await second.d.downloadAudio(TARGET);
    expect(second.runs).toEqual([PROXIES[1]]);
  });

  it('does not spawn yt-dlp at all once the whole pool is quarantined', async () => {
    const health = new ProxyHealth(60_000, () => 0);
    const first = downloader([AUTH_ERROR, AUTH_ERROR], health);
    await first.d.downloadAudio(TARGET).catch(() => {});

    const second = downloader([AUTH_ERROR], health);
    await expect(second.d.downloadAudio(TARGET)).rejects.toThrow(/every proxy in the pool \(2\)/);
    expect(second.runs).toHaveLength(0);
  });

  // With no pool configured there is nothing to quarantine and no account to
  // blame — a direct attempt that fails is just a failed download.
  it('keeps the no-proxy path retryable', async () => {
    const { d, runs } = downloader([AUTH_ERROR], new ProxyHealth(60_000, () => 0), []);
    const r = await d.downloadAudio(TARGET);
    expect(r.isFail()).toBe(true);
    expect(runs).toEqual([undefined]);
  });
});
