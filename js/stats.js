// Anonymous, cookie-free play stats (see supabase_stats_schema.sql for what's stored and why it
// identifies nobody). Every call is fire-and-forget: a slow, blocked or failing stats request
// must never affect the game, so nothing here throws or returns a promise to await.

export const EVENT_KINDS = ['visit', 'game_start', 'game_over', 'victory', 'quit', 'shop_open', 'checkout_start'];

// Only the real site reports. Local copies, previews and tests stay silent so they can't
// pollute the numbers.
export const TRACKED_HOST = 'pigsgonnablow.com';

const REF_RE = /^[a-z0-9._-]{1,40}$/;

// Where this visit came from: an explicit ?ref= tag wins (so a link like
// pigsgonnablow.com/?ref=bsky is attributable even from apps that send no referrer), then the
// referring site's hostname, then 'direct'. Same-site navigation counts as 'direct'.
export function refFrom(href, referrer){
  let own = '';
  try {
    const u = new URL(href);
    own = u.hostname.replace(/^www\./, '');
    const tag = (u.searchParams.get('ref') || '').toLowerCase();
    if (REF_RE.test(tag)) return tag;
  } catch (e) { /* fall through */ }
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
    if (host && host !== own && REF_RE.test(host)) return host;
  } catch (e) { /* no or unparseable referrer */ }
  return 'direct';
}

export function isTrackedHost(hostname){
  const h = String(hostname || '').toLowerCase();
  return h === TRACKED_HOST || h.endsWith('.' + TRACKED_HOST);
}

// A coarse pointer (finger) means phone or tablet; anything else is treated as desktop. Only
// this one word is recorded -- no user agent, screen size or anything else fingerprint-y.
export const deviceFrom = (coarsePointer) => (coarsePointer ? 'mobile' : 'desktop');

// Whole, non-negative, and capped to what the database accepts; anything else is sent as null.
function wholeOrNull(v, max){
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : null;
}

export function createStats({ url, anonKey, href, referrer, hostname, coarsePointer, fetchImpl }){
  const enabled = isTrackedHost(hostname) && typeof fetchImpl === 'function';
  const ref = refFrom(href, referrer);
  const device = deviceFrom(coarsePointer);

  // `extra` is optional: { level, score, seconds } for the events that end a run.
  function track(kind, extra = {}){
    if (!enabled || !EVENT_KINDS.includes(kind)) return;
    try {
      fetchImpl(url + '/rest/v1/rpc/log_event', {
        method: 'POST',
        keepalive: true, // lets a game_over/quit sent while the tab closes still arrive
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          p_kind: kind,
          p_level: wholeOrNull(extra.level, 999) ?? 0,
          p_ref: ref,
          p_device: device,
          p_score: wholeOrNull(extra.score, 1000000),
          p_seconds: wholeOrNull(extra.seconds, 86400)
        })
      }).catch(() => {});
    } catch (e) { /* never let stats break the game */ }
  }

  return { track, ref, device, enabled };
}
