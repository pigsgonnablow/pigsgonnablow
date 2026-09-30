import { describe, it, expect, vi } from 'vitest';
import { createStats, refFrom, isTrackedHost, EVENT_KINDS } from '../../js/stats.js';

const LIVE = { url: 'https://x.supabase.co', anonKey: 'k', href: 'https://www.pigsgonnablow.com/', referrer: '', hostname: 'www.pigsgonnablow.com' };

describe('refFrom', () => {
  it('prefers a valid ?ref= tag', () => {
    expect(refFrom('https://www.pigsgonnablow.com/?ref=Bsky', 'https://www.reddit.com/r/x')).toBe('bsky');
  });
  it('falls back to the referring hostname without www.', () => {
    expect(refFrom('https://www.pigsgonnablow.com/', 'https://www.reddit.com/r/IndieDev/abc')).toBe('reddit.com');
  });
  it('ignores a junk tag, same-site referrers and missing referrers', () => {
    expect(refFrom('https://www.pigsgonnablow.com/?ref=<b>', '')).toBe('direct');
    expect(refFrom('https://www.pigsgonnablow.com/', 'https://pigsgonnablow.com/privacy.html')).toBe('direct');
    expect(refFrom('https://www.pigsgonnablow.com/', '')).toBe('direct');
  });
});

describe('isTrackedHost', () => {
  it('only the live domain reports', () => {
    expect(isTrackedHost('www.pigsgonnablow.com')).toBe(true);
    expect(isTrackedHost('pigsgonnablow.com')).toBe(true);
    expect(isTrackedHost('localhost')).toBe(false);
    expect(isTrackedHost('notpigsgonnablow.com')).toBe(false);
    expect(isTrackedHost('mherr170.github.io')).toBe(false);
  });
});

describe('createStats', () => {
  it('posts to the log_event RPC with the publishable key and a clamped level', () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true }));
    createStats({ ...LIVE, referrer: 'https://bsky.app/profile/x', coarsePointer: true, fetchImpl }).track('game_over', { level: 7.9, score: 420, seconds: 61.7 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://x.supabase.co/rest/v1/rpc/log_event');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(init.headers.apikey).toBe('k');
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      p_kind: 'game_over', p_level: 7, p_ref: 'bsky.app', p_device: 'mobile', p_score: 420, p_seconds: 61,
    });
  });

  it('events without run details send level 0 and nulls; a desktop pointer reports desktop', () => {
    const fetchImpl = vi.fn(() => Promise.resolve());
    createStats({ ...LIVE, coarsePointer: false, fetchImpl }).track('visit');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      p_kind: 'visit', p_level: 0, p_ref: 'direct', p_device: 'desktop', p_score: null, p_seconds: null,
    });
  });

  it('sends nothing off the live domain, or for an unknown kind', () => {
    const fetchImpl = vi.fn(() => Promise.resolve());
    createStats({ ...LIVE, hostname: 'localhost', fetchImpl }).track('visit');
    createStats({ ...LIVE, fetchImpl }).track('not_a_kind');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws, whether fetch throws synchronously or rejects', async () => {
    const boom = createStats({ ...LIVE, fetchImpl: () => { throw new Error('blocked'); } });
    const reject = createStats({ ...LIVE, fetchImpl: () => Promise.reject(new Error('offline')) });
    expect(() => boom.track('visit')).not.toThrow();
    expect(() => reject.track('visit')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // an unhandled rejection would fail the run
  });

  it('its kinds match the database check constraint', () => {
    expect(EVENT_KINDS).toEqual(['visit', 'game_start', 'game_over', 'victory', 'quit', 'shop_open', 'checkout_start']);
  });
});
