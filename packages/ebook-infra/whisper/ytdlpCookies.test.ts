import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveCookiesFile, resetCookiesFileCache } from './ytdlpCookies';

const JAR = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalue\n';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    file: process.env.YT_DLP_COOKIES_FILE,
    b64: process.env.YT_DLP_COOKIES_B64,
  };
  delete process.env.YT_DLP_COOKIES_FILE;
  delete process.env.YT_DLP_COOKIES_B64;
  resetCookiesFileCache();
});

afterEach(() => {
  for (const [k, v] of [['YT_DLP_COOKIES_FILE', saved.file], ['YT_DLP_COOKIES_B64', saved.b64]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetCookiesFileCache();
});

describe('resolveCookiesFile', () => {
  it('is undefined when neither var is set — the ungated-video path still works', () => {
    expect(resolveCookiesFile()).toBeUndefined();
  });

  it('prefers an explicit path over the encoded jar', () => {
    process.env.YT_DLP_COOKIES_FILE = '/etc/cookies.txt';
    process.env.YT_DLP_COOKIES_B64 = b64(JAR);
    expect(resolveCookiesFile()).toBe('/etc/cookies.txt');
  });

  it('materializes the encoded jar to a file yt-dlp can read', () => {
    process.env.YT_DLP_COOKIES_B64 = b64(JAR);
    const path = resolveCookiesFile();
    expect(path).toBeDefined();
    expect(readFileSync(path!, 'utf8')).toBe(JAR);
  });

  // A mis-encoded secret (double-base64, a pasted JSON blob, a truncated copy)
  // makes yt-dlp ignore the jar silently — and the run then fails with the exact
  // bot-gate error the cookies were added to fix. Failing at startup keeps that
  // from being diagnosed a second time as a proxy problem.
  it('rejects a payload that is not a Netscape cookie jar', () => {
    process.env.YT_DLP_COOKIES_B64 = b64('{"cookies":[]}');
    expect(() => resolveCookiesFile()).toThrow(/Netscape/);
  });

  it('writes once and reuses the path across the many yt-dlp runs of one book', () => {
    process.env.YT_DLP_COOKIES_B64 = b64(JAR);
    expect(resolveCookiesFile()).toBe(resolveCookiesFile());
  });
});
