/**
 * Shared rendering primitives for both landing-page paths — the built-in
 * template and the model-generated layout. Kept in one place so escaping and
 * money formatting can never drift between them.
 */

/**
 * Escapes into HTML text/attribute context. Every externally-sourced string
 * passes through here, so prose from the model and a checkout URL from the user
 * are both inert data — they can never become markup.
 */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$' };

export function money(cents: number, currency: string): string {
  const amount = cents / 100;
  // Whole prices ($47) read better than padded ones ($47.00) in a headline.
  const text = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const symbol = SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${text}` : `${text} ${currency.toUpperCase()}`;
}

/** Compact subscriber-style counts: 280000 → "280K". */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Roman numeral for an edition line, e.g. 2026 → "MMXXVI". */
export function romanYear(year: number): string {
  const table: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let n = year;
  let out = '';
  for (const [value, sym] of table) {
    while (n >= value) {
      out += sym;
      n -= value;
    }
  }
  return out;
}

/**
 * The reveal-on-scroll and countdown behaviour, shared by both paths.
 *
 * `arming` runs in <head> before first paint so nothing flashes in and then
 * hides; `observer` runs at the end of <body>. The hidden start state is scoped
 * to a class only JavaScript adds, and the arming script strips it again if the
 * observer never reports ready — so a blocked or broken script leaves a plain,
 * fully visible page rather than a blank one.
 */
export const ARMING_SCRIPT = `(function () {
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var root = document.documentElement;
    root.className += ' anim';
    setTimeout(function () {
      if (root.getAttribute('data-anim') !== 'ready') root.className = root.className.replace(' anim', '');
    }, 2500);
  } catch (e) { /* leave the page in its plain, fully visible state */ }
})();`;

export const OBSERVER_SCRIPT = `(function () {
  var root = document.documentElement;
  if (root.className.indexOf('anim') > -1) {
    var els = document.querySelectorAll('.reveal, .stagger > *, section');
    root.setAttribute('data-anim', 'ready');
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            entries[i].target.classList.add('in');
            io.unobserve(entries[i].target);
          }
        }
      }, { threshold: 0.06, rootMargin: '0px 0px -6% 0px' });
      for (var j = 0; j < els.length; j++) io.observe(els[j]);
    } else {
      for (var k = 0; k < els.length; k++) els[k].classList.add('in');
    }
  }

  /* Later cover slots reuse the first cover's bytes instead of embedding the
     data URI once per slot — six embedded copies would be a multi-MB page. */
  var coverSrc = (document.querySelector('img.cover[src^="data:"]') || {}).src;
  if (coverSrc) {
    var copies = document.querySelectorAll('img[data-cover-copy]');
    for (var c = 0; c < copies.length; c++) copies[c].src = coverSrc;
  }

  /* The deadline is a real stored date, never "now + 24h" — a timer that resets
     on every visit is a false urgency claim, and an actionable one. */
  var promo = document.querySelector('[data-ends]');
  var out = promo && promo.querySelector('[data-countdown]');
  if (!promo || !out) return;
  var ends = Date.parse(promo.getAttribute('data-ends'));
  if (isNaN(ends)) { promo.style.display = 'none'; return; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function tick() {
    var left = ends - Date.now();
    if (left <= 0) { promo.style.display = 'none'; return; }
    var d = Math.floor(left / 86400000);
    out.textContent = (d > 0 ? d + 'd ' : '') + pad(Math.floor(left / 3600000) % 24) + ':' +
      pad(Math.floor(left / 60000) % 60) + ':' + pad(Math.floor(left / 1000) % 60);
    setTimeout(tick, 1000);
  }
  tick();
})();`;

/**
 * Reveal styling applied to whatever the model produced. Scoped to `.anim`, and
 * targeting `section` generically, so a generated layout animates without the
 * model having to know about our class names.
 */
export const REVEAL_CSS = `
  .anim section, .anim .reveal, .anim .stagger > * {
    opacity: 0; transform: translateY(18px);
    transition: opacity .55s ease, transform .55s cubic-bezier(.22,.61,.36,1);
  }
  .anim section.in, .anim .reveal.in, .anim .stagger > *.in { opacity: 1; transform: none; }
  /* Grid/list children marked .stagger arrive in sequence, not as one slab. */
  .anim .stagger > *:nth-child(2) { transition-delay: .07s; }
  .anim .stagger > *:nth-child(3) { transition-delay: .14s; }
  .anim .stagger > *:nth-child(4) { transition-delay: .21s; }
  .anim .stagger > *:nth-child(5) { transition-delay: .28s; }
  .anim .stagger > *:nth-child(6) { transition-delay: .35s; }
  .anim .stagger > *:nth-child(n+7) { transition-delay: .42s; }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }`;
