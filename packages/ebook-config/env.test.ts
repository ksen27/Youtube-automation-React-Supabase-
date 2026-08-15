import { describe, it, expect } from 'vitest';
import { parseEnv } from './env';

/**
 * Boolean env flags must be switchable OFF.
 *
 * `z.coerce.boolean()` calls `Boolean(value)`, and `Boolean("false")` is true —
 * so a flag declared that way is permanently on, whatever the operator sets.
 * `PAYHIP_USE_STEALTH=false` was set as a Fly secret and the worker ran with
 * stealth ON for a day, with every log line reporting `stealth: true` while the
 * operator could see they had set it false. The local CLI reads `process.env`
 * directly and honoured the "false", so the same setting behaved one way on a
 * laptop and the opposite way in production — which is what made it take so
 * long to spot.
 */

/** The minimum a valid env needs, so these tests are about the flags only. */
const BASE = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  REDIS_URL: 'redis://localhost:6379',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  YOUTUBE_API_KEY: 'yt-test',
} as unknown as NodeJS.ProcessEnv;

describe('boolean environment flags', () => {
  it('treats "false" as OFF, not as a non-empty string', () => {
    const env = parseEnv({ ...BASE, PAYHIP_USE_STEALTH: 'false' });
    expect(env.PAYHIP_USE_STEALTH).toBe(false);
  });

  it('accepts the other ways an operator writes "off"', () => {
    for (const off of ['0', 'no', 'off', 'FALSE', ' false ']) {
      expect(parseEnv({ ...BASE, PAYHIP_USE_STEALTH: off }).PAYHIP_USE_STEALTH).toBe(false);
    }
  });

  it('treats anything else as ON', () => {
    for (const on of ['true', '1', 'yes', 'on']) {
      expect(parseEnv({ ...BASE, PAYHIP_HEADED: on }).PAYHIP_HEADED).toBe(true);
    }
  });

  it('keeps its default when unset', () => {
    const env = parseEnv({ ...BASE });
    // Stealth defaults ON (Cloudflare); the other two default OFF.
    expect(env.PAYHIP_USE_STEALTH).toBe(true);
    expect(env.PAYHIP_HEADED).toBe(false);
    expect(env.PAYHIP_CONNECT_USES_PROXY).toBe(false);
  });
});
