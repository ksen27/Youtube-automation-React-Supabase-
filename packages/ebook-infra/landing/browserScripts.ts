/**
 * The DOM work, as source text evaluated inside the page.
 *
 * Written as strings rather than functions because this package does not
 * compile against the DOM lib — the same reason `PuppeteerReferenceScreenshotter`
 * passes source text to `page.evaluate`.
 *
 * Doing this work in the browser rather than over the HTML string is the whole
 * technique. A real DOM gives node identity (so a placeholder can be addressed
 * and applied without parsing), and `getComputedStyle` gives resolved values —
 * which is why the entire `var(--token)` resolution problem that broke v1's
 * style detection simply does not arise here. We never have to work out that
 * `--font-display` is DM Serif Display; the browser already did.
 */

/**
 * Scrolls the page end to end so lazy images load and IntersectionObserver
 * reveals fire naturally, then returns to the top.
 *
 * Forcing reveals open comes later and is a last resort — letting them fire the
 * way a real visitor triggers them produces the state the template's author
 * intended, including any staggered transforms that have settled by then.
 */
export const AUTOSCROLL = `(async function () {
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  let last = -1;
  for (let y = 0; y < 200000; y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
    const height = document.body.scrollHeight;
    if (y > height) break;
    if (height === last && y > height - window.innerHeight) break;
    last = height;
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 300));
  try { await document.fonts.ready; } catch (e) { /* no font API */ }
  return document.body.scrollHeight;
})()`;

/**
 * Forces open anything still hidden by a reveal-on-scroll library.
 *
 * This is the single most likely way a cloned page comes back blank. AOS, WOW,
 * ScrollReveal and most Framer/GSAP setups paint elements at `opacity: 0` and
 * let a script raise them. Strip the scripts and every one of those elements
 * stays invisible forever — the page renders as an empty column.
 *
 * Deliberately narrow: only elements that are actually invisible AND carry text
 * or an image are touched, and the inline override is the minimum that undoes
 * the hiding. An element the designer meant to be invisible (a hidden mobile
 * menu, a print-only block) is left alone because its parent is hidden too.
 */
export const UNHIDE_REVEALS = `(function () {
  const REVEAL_ATTRS = ['data-aos', 'data-sr-id', 'data-scroll', 'data-animate', 'data-reveal', 'data-wow-delay'];
  const REVEAL_CLASSES = /(^|\\s)(aos-init|wow|sr-|reveal|fade-in|animate__|scroll-animate|js-reveal)/i;
  let forced = 0;

  const all = document.querySelectorAll('body *');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const style = getComputedStyle(el);
    const invisible =
      parseFloat(style.opacity) < 0.05 ||
      style.visibility === 'hidden' ||
      /translate|scale\\(0/.test(style.transform || '');
    if (!invisible) continue;

    // Only reveal what a reader was meant to see: some text or an image.
    const meaningful = (el.textContent || '').trim().length > 1 || el.querySelector('img, svg, picture');
    if (!meaningful) continue;

    // An element hidden because an ANCESTOR is hidden (a closed mobile menu)
    // must stay hidden — forcing it open paints a nav drawer over the page.
    let ancestorHidden = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.display === 'none' || ps.visibility === 'hidden' || parseFloat(ps.opacity) < 0.05) {
        ancestorHidden = true;
        break;
      }
    }
    if (ancestorHidden) continue;

    const looksLikeReveal =
      REVEAL_CLASSES.test(el.className && el.className.baseVal !== undefined ? '' : String(el.className || '')) ||
      REVEAL_ATTRS.some((a) => el.hasAttribute(a));

    // Anything invisible after a full scroll is treated as a stuck reveal even
    // without a recognisable marker: bespoke IntersectionObserver code is
    // common and carries no library signature at all.
    el.style.setProperty('opacity', '1', 'important');
    el.style.setProperty('visibility', 'visible', 'important');
    el.style.setProperty('transform', 'none', 'important');
    el.style.setProperty('animation', 'none', 'important');
    el.style.setProperty('transition', 'none', 'important');
    for (const a of REVEAL_ATTRS) el.removeAttribute(a);
    forced++;
    void looksLikeReveal;
  }
  return forced;
})()`;

/**
 * Opens every collapsed disclosure, while the script that manages it is alive.
 *
 * Must run BEFORE cleaning, and that ordering is the whole point. Modern
 * accordion libraries UNMOUNT a closed panel rather than hiding it: the
 * reference template's six FAQ answers were not hidden in the captured DOM,
 * they were absent — six triggers and six empty divs. Capturing that gives a
 * template whose answers can never be filled, because there is no node to fill.
 *
 * Clicking each trigger first makes React mount the content, so the answer text
 * is present to be measured and labelled. The disclosure is put back into a
 * closed <details> afterwards, so the published page still opens on click.
 */
export const OPEN_DISCLOSURES = `(async function () {
  const triggers = document.querySelectorAll('[aria-controls][aria-expanded="false"]');
  let opened = 0;
  for (let i = 0; i < triggers.length && i < 40; i++) {
    try {
      triggers[i].click();
      opened++;
      // Let the framework mount and paint before the next one — several kits
      // close the previous panel when another opens, and a batch of synchronous
      // clicks would leave only the last one mounted.
      await new Promise((r) => setTimeout(r, 60));
    } catch (e) { /* a trigger that refuses to be clicked is not fatal */ }
  }
  await new Promise((r) => setTimeout(r, 250));
  return opened;
})()`;

/**
 * Removes everything that must not be republished: executable content, the
 * template owner's identity, trackers and overlays.
 *
 * Returns a tally so the extraction report can say what was taken out — a
 * template that lost four `<iframe>` embeds is still usable, but the seller
 * should be told rather than left to notice.
 */
export const CLEAN = `(function () {
  const removed = { scripts: 0, embeds: 0, forms: 0, trackers: 0, overlays: 0, identity: 0, handlers: 0 };

  const drop = (selector, key) => {
    const nodes = document.querySelectorAll(selector);
    for (let i = 0; i < nodes.length; i++) { nodes[i].remove(); removed[key]++; }
  };

  drop('script, noscript', 'scripts');
  drop('iframe, object, embed, canvas', 'embeds');
  drop('link[rel="preconnect"], link[rel="dns-prefetch"], link[rel="preload"][as="script"]', 'trackers');

  // The owner's SEO identity. Every one of these names THEIR product, and a
  // cloned page carrying them is a page telling search engines it is the
  // original. Regenerated for the new product at bind time.
  drop('title, link[rel="canonical"], script[type="application/ld+json"]', 'identity');
  const metas = document.querySelectorAll('meta');
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i];
    const name = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
    if (/^(og:|twitter:|description|keywords|author|robots)/.test(name)) { m.remove(); removed.identity++; }
  }

  // Forms are unwrapped rather than deleted: the markup inside one is often
  // ordinary layout, and removing the whole thing takes a section with it.
  const forms = document.querySelectorAll('form');
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    const div = document.createElement('div');
    while (form.firstChild) div.appendChild(form.firstChild);
    for (let a = 0; a < form.attributes.length; a++) {
      const attr = form.attributes[a];
      if (attr.name === 'class' || attr.name === 'id' || attr.name === 'style') div.setAttribute(attr.name, attr.value);
    }
    form.replaceWith(div);
    removed.forms++;
  }
  drop('input, select, textarea, button[type="submit"]', 'forms');

  // Tracking pixels.
  const imgs = document.querySelectorAll('img');
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i];
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if ((w > 0 && w <= 2) || (h > 0 && h <= 2)) { img.remove(); removed.trackers++; }
  }

  // Consent banners, chat widgets and sticky promos. Most die with their
  // scripts; these are the ones rendered server-side. Matched on BOTH a
  // fixed/sticky position and a recognisable name, because plenty of
  // legitimate sales-page furniture is fixed-position — a sticky buy bar, for
  // one, which must survive.
  const OVERLAY = /(cookie|consent|gdpr|chat-widget|intercom|drift|crisp|tawk|hubspot-messages|onetrust|cky-)/i;
  const all = document.querySelectorAll('body > *, body > * > *');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const style = getComputedStyle(el);
    if (style.position !== 'fixed' && style.position !== 'sticky') continue;
    const name = String(el.className || '') + ' ' + String(el.id || '');
    if (OVERLAY.test(name)) { el.remove(); removed.overlays++; }
  }

  // Inline handlers and javascript: URLs.
  const every = document.querySelectorAll('*');
  for (let i = 0; i < every.length; i++) {
    const el = every[i];
    const attrs = Array.prototype.slice.call(el.attributes);
    for (let a = 0; a < attrs.length; a++) {
      const attr = attrs[a];
      if (/^on/i.test(attr.name)) { el.removeAttribute(attr.name); removed.handlers++; }
      else if (/^javascript:/i.test(attr.value || '')) { el.setAttribute(attr.name, '#'); removed.handlers++; }
    }
  }

  return removed;
})()`;

/**
 * Gives collapsed content back its open/close behaviour, without a script.
 *
 * Cleaning removes every `<script>`, which is not negotiable — a cloned page
 * must not run the template owner's code. But an accordion driven by that
 * script becomes dead rows: the answers are in the markup, they get filled with
 * the seller's copy, and no click can ever reveal them. That is a FAQ section
 * that looks complete and shows nothing, which is exactly what shipped.
 *
 * `<details>`/`<summary>` is the one native disclosure primitive. The original
 * nodes are re-parented rather than rebuilt, so the template's own styling —
 * the row background, the chevron, the padding — comes along untouched.
 *
 * Runs AFTER cleaning, so the scripts whose absence it compensates for are
 * already gone, and before stamping, so every moved node still gets an id.
 */
export const RESTORE_DISCLOSURE = `(function () {
  const DISCLOSURE = /(accordion|faq|collapse|collapsible|disclosure|toggle)/i;
  const MENU_LIKE = /(nav|menu|drawer|modal|dialog|popup|overlay|tooltip|dropdown|offcanvas)/i;
  const nameOf = (el) => String(el.className || '') + ' ' + String(el.id || '');

  const isHidden = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    if (el.hasAttribute('hidden')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.getAttribute('data-state') === 'closed') return true;
    // A max-height:0 clip is the other common accordion mechanism.
    return (style.maxHeight === '0px' || parseFloat(style.maxHeight) === 0) && style.overflow !== 'visible';
  };

  // The template may already do this natively, in which case there is nothing
  // to repair and touching it would only risk breaking what works.
  if (document.querySelector('details')) return { restored: 0, native: true };

  let restored = 0;

  /**
   * The ACCESSIBLE construction, tried first: a button declares whether its
   * panel is open and names it by id.
   *
   * This is what every headless UI kit emits — Radix, Headless UI, Reach — and
   * it is what the reference template uses. The structural heuristic below
   * cannot see it, because the trigger and the panel are not siblings under a
   * shared row: the button carries aria-controls and the panel lives wherever
   * the library put it. Six collapsed FAQ rows were missed that way, and the
   * cloned page rendered every answer expanded beneath its question.
   */
  const triggers = document.querySelectorAll('[aria-controls][aria-expanded]');
  for (let i = 0; i < triggers.length && restored < 40; i++) {
    const trigger = triggers[i];
    if (!trigger.isConnected) continue;
    const panelId = trigger.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!panel || !panel.isConnected || panel === trigger || panel.contains(trigger)) continue;
    // The panel may legitimately be EMPTY: a library that unmounts closed
    // content leaves the container behind. That container is still the right
    // place for the answer, so it is converted rather than skipped.
    if (!(trigger.textContent || '').trim()) continue;

    const details = document.createElement('details');
    // Open when the template had it open — a "what you get" panel is sometimes
    // expanded by default, and closing it would hide content a reader was
    // meant to see without clicking.
    if (trigger.getAttribute('aria-expanded') === 'true') details.setAttribute('open', '');

    const summary = document.createElement('summary');
    // The trigger's own classes and children, so the row keeps the template's
    // styling. A <button> cannot stay inside <summary> — it would swallow the
    // click that opens the disclosure.
    summary.setAttribute('class', String(trigger.getAttribute('class') || ''));
    while (trigger.firstChild) summary.appendChild(trigger.firstChild);

    // The library's state attributes go with the script that managed them.
    panel.removeAttribute('hidden');
    panel.removeAttribute('aria-hidden');
    if (panel.getAttribute('data-state') === 'closed') panel.setAttribute('data-state', 'open');
    panel.style.removeProperty('display');
    panel.style.removeProperty('max-height');
    panel.style.removeProperty('height');

    trigger.replaceWith(details);
    details.appendChild(summary);
    details.appendChild(panel);
    restored++;
  }

  const rows = document.querySelectorAll('div, li, article, section');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.isConnected) continue;
    if (restored >= 40) break;

    // Scoped to regions that name themselves a disclosure — on the row or on an
    // ancestor, since the item class is often generic ("item", "card") while
    // the wrapper is "faq-list". A hidden div in the hero is not an accordion.
    let named = false;
    for (let n = row; n && n !== document.body; n = n.parentElement) {
      if (MENU_LIKE.test(nameOf(n))) { named = false; break; }
      if (DISCLOSURE.test(nameOf(n))) { named = true; break; }
    }
    if (!named) continue;

    // A row is a trigger followed by a hidden body. Both must be direct
    // children, which is what distinguishes a row from the list around it.
    const kids = Array.prototype.slice.call(row.children);
    if (kids.length < 2) continue;

    let triggerIdx = -1;
    for (let k = 0; k < kids.length; k++) {
      const kid = kids[k];
      if (isHidden(kid)) continue;
      if (!(kid.textContent || '').trim()) continue;
      triggerIdx = k;
      break;
    }
    if (triggerIdx < 0) continue;

    let bodyIdx = -1;
    for (let k = triggerIdx + 1; k < kids.length; k++) {
      if (isHidden(kids[k]) && (kids[k].textContent || '').trim()) { bodyIdx = k; break; }
    }
    if (bodyIdx < 0) continue;

    const trigger = kids[triggerIdx];
    const body = kids[bodyIdx];

    // The inline hiding goes with the script that managed it: <details> now
    // owns the state, and a leftover display:none keeps the answer invisible
    // even when the row is open.
    body.removeAttribute('hidden');
    body.removeAttribute('aria-hidden');
    if (body.getAttribute('data-state') === 'closed') body.setAttribute('data-state', 'open');
    if (body.style) {
      body.style.removeProperty('display');
      body.style.removeProperty('visibility');
      body.style.removeProperty('max-height');
      body.style.removeProperty('overflow');
    }
    // A stylesheet rule can re-hide it, which inline styles are needed to beat.
    if (isHidden(body)) {
      body.style.setProperty('display', 'block', 'important');
      body.style.setProperty('visibility', 'visible', 'important');
      body.style.setProperty('max-height', 'none', 'important');
    }
    // aria-expanded on the trigger would now contradict the real state.
    trigger.removeAttribute('aria-expanded');

    const details = document.createElement('details');
    details.setAttribute('data-restored', '');
    const summary = document.createElement('summary');
    row.insertBefore(details, trigger);
    summary.appendChild(trigger);
    details.appendChild(summary);
    details.appendChild(body);
    restored++;
  }

  return { restored: restored, native: false };
})()`;

/**
 * Stamps every element with a stable address.
 *
 * Monotonic in document order over the cleaned tree, so an id means the same
 * node for the life of one extraction. This is what lets the annotation model
 * name a node without ever seeing or writing markup.
 */
export const STAMP = `(function () {
  const all = document.querySelectorAll('body, body *');
  for (let i = 0; i < all.length; i++) all[i].setAttribute('data-tpl', 'n' + i);
  return all.length;
})()`;

/** Shared helpers, prepended to the scripts that need them. */
const HELPERS = `
  /**
   * Any CSS colour to [r,g,b], by asking the browser rather than parsing it.
   *
   * A regex over rgb()/rgba() is wrong on this template and on most modern
   * ones: Tailwind v4 and every design-token build emit oklch(), and
   * getComputedStyle hands that straight back. It produced no accent at all and
   * reported a dark page as light — the same class of failure v1's detectors
   * had, reproduced here by parsing strings instead of asking the engine that
   * already knows the answer.
   *
   * A 1x1 canvas handles every format the browser understands: oklch, lab,
   * color-mix, hsl, named colours. The browser does the conversion.
   */
  const rgbProbe = document.createElement('canvas');
  rgbProbe.width = 1;
  rgbProbe.height = 1;
  const rgbCtx = rgbProbe.getContext('2d', { willReadFrequently: true });
  const toRgb = (value) => {
    if (!value) return null;
    try {
      rgbCtx.clearRect(0, 0, 1, 1);
      // An unparseable value leaves fillStyle untouched, so a sentinel is what
      // tells "could not parse" apart from "genuinely black".
      rgbCtx.fillStyle = '#010203';
      rgbCtx.fillStyle = value;
      if (rgbCtx.fillStyle === '#010203') return null;
      rgbCtx.fillRect(0, 0, 1, 1);
      const d = rgbCtx.getImageData(0, 0, 1, 1).data;
      // Fully transparent is not a colour. Reporting it as black is how a
      // transparent header ends up matching a token and becoming the accent.
      if (d[3] === 0) return null;
      return [d[0], d[1], d[2]];
    } catch (e) {
      return null;
    }
  };
  const hex = (value) => {
    const c = toRgb(value);
    if (!c) return null;
    const h = (n) => n.toString(16).padStart(2, '0');
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  };
  const luminance = (value) => {
    const c = toRgb(value);
    if (!c) return 1;
    const lin = c.map((n) => {
      const s = n / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; node && i < 4; i++) {
      const cls = String(node.className || '').split(/\\s+/).filter(Boolean).slice(0, 1).join('');
      parts.unshift(node.tagName.toLowerCase() + (cls ? '.' + cls : ''));
      node = node.parentElement;
      if (!node || node === document.body) break;
    }
    return parts.join('>');
  };
  const sectionOf = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const tag = n.tagName.toLowerCase();
      if (tag === 'section' || tag === 'header' || tag === 'footer' || tag === 'main' || tag === 'article') {
        return n.getAttribute('data-tpl');
      }
    }
    return null;
  };
  /** Text belonging to THIS element, not inherited from descendants. */
  const ownText = (el) => {
    let out = '';
    for (let i = 0; i < el.childNodes.length; i++) {
      const n = el.childNodes[i];
      if (n.nodeType === 3) out += n.nodeValue;
    }
    return out.replace(/\\s+/g, ' ').trim();
  };
  /**
   * Whether a hidden node is COLLAPSED content rather than a separate UI state.
   *
   * The distinction decides whether the text is part of the page. An FAQ answer
   * in a shut accordion is; a closed mobile menu, a modal and an off-screen
   * carousel slide are not — the menu duplicates the nav, and inventorying it
   * gives the annotation model two copies of every link to choose between.
   *
   * Recognised by the disclosure patterns the web actually uses: a <details>
   * that is not open, an aria-expanded/aria-hidden pairing, or a container
   * whose own name says accordion/faq/collapse. Deliberately narrow — a node
   * that merely happens to be hidden is still skipped.
   */
  const DISCLOSURE = /(accordion|faq|collapse|collapsible|disclosure|expand|toggle|answer)/i;
  const MENU_LIKE = /(nav|menu|drawer|modal|dialog|popup|overlay|tooltip|dropdown|offcanvas|slide)/i;
  const isCollapsedContent = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const name = String(n.className || '') + ' ' + String(n.id || '');
      // A menu or modal wrapper anywhere above disqualifies it, even if some
      // inner element is also called "expand".
      if (MENU_LIKE.test(name)) return false;
      if (n.tagName === 'DETAILS') return !n.hasAttribute('open');
      if (n.getAttribute('aria-expanded') === 'false') return true;
      if (n.getAttribute('aria-hidden') === 'true' && DISCLOSURE.test(name)) return true;
      if (n.hasAttribute('data-state') && n.getAttribute('data-state') === 'closed') return true;
      if (DISCLOSURE.test(name)) return true;
    }
    return false;
  };
`;

/**
 * The candidate nodes offered to the annotation model.
 *
 * A node qualifies if it holds its own text, or is an image, or is a link.
 * Everything else is structure, which is not up for replacement.
 *
 * Capped, and the cap drops the least useful first — deepest and shortest.
 * A long sales page yields 200–400 candidates, which is a comfortable JSON
 * payload; a pathological page must not become an unbounded one.
 */
export const INVENTORY = `(function () {
  ${HELPERS}
  const MAX = 500;
  const out = [];
  const all = document.querySelectorAll('body *');

  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const tag = el.tagName.toLowerCase();
    const tplId = el.getAttribute('data-tpl');
    if (!tplId) continue;

    const style = getComputedStyle(el);
    // Hidden nodes are skipped — a closed mobile menu duplicates the whole nav,
    // and a modal's copy is not page content — EXCEPT where the hiding is a
    // collapse. An FAQ answer inside a shut accordion is the page's real
    // content, and dropping it produced exactly the visible defect: a cloned
    // page with six question rows and nothing behind any of them, because the
    // answers were never inventoried, never labelled, and never filled.
    if ((style.display === 'none' || style.visibility === 'hidden') && !isCollapsedContent(el)) continue;

    const rect = el.getBoundingClientRect();
    const isImage = tag === 'img';
    const isLink = tag === 'a' || tag === 'button';
    const text = ownText(el);

    if (!isImage && !isLink && text.length < 2) continue;
    // A link with no text and no image is a bare icon or a skip target.
    if (isLink && text.length < 1 && !el.querySelector('img, svg')) continue;

    const node = {
      tplId: tplId,
      tag: tag,
      path: pathOf(el),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
    if (text) { node.text = text.slice(0, 300); node.chars = text.length; }
    if (isImage) {
      node.src = el.currentSrc || el.src || '';
      node.alt = el.getAttribute('alt') || '';
      node.width = Math.round(rect.width);
      node.height = Math.round(rect.height);
    }
    if (tag === 'a') node.href = el.getAttribute('href') || '';
    const section = sectionOf(el);
    if (section) node.sectionId = section;
    if (text && el.children.length > 0) node.hasInlineMarkup = true;
    // Collapsed content measures 0x0, so the annotation model would otherwise
    // read it as an empty node. Flagged rather than dropped: an FAQ answer is
    // the most important text in its section.
    if (style.display === 'none' || style.visibility === 'hidden') node.collapsed = true;
    out.push(node);
  }

  if (out.length <= MAX) return out;
  // Keep images and links unconditionally — they carry the commerce — plus
  // collapsed content, which is a whole section's answers and would otherwise
  // be cut first for having no measured size. Then the longest text nodes,
  // which are the ones that read as content.
  const isPriority = (n) => n.tag === 'img' || n.tag === 'a' || n.tag === 'button' || n.collapsed;
  const priority = out.filter(isPriority);
  const rest = out.filter((n) => !isPriority(n))
                  .sort((a, b) => (b.chars || 0) - (a.chars || 0))
                  .slice(0, Math.max(0, MAX - priority.length));
  const keep = new Set(priority.concat(rest).map((n) => n.tplId));
  return out.filter((n) => keep.has(n.tplId));
})()`;

/**
 * Containers whose children repeat — benefit cards, FAQ rows, pricing tiers.
 *
 * Structural signature only: tag, class list and the tag skeleton of the
 * subtree. Text is ignored on purpose, because the whole point is that three
 * cards saying different things are the same card three times.
 *
 * `flexibleCount` is read from the container's own computed
 * `grid-template-columns`. An `auto-fit`/`auto-fill` grid reflows to any number
 * of items; a hand-tuned three-across flex row does not, and giving it five
 * breaks the design. That is a measurement, not a guess.
 */
export const DETECT_REPEATERS = `(function () {
  ${HELPERS}
  const MIN_COVERAGE = 0.7;
  const out = [];
  const containers = document.querySelectorAll('body *');

  const signature = (el) => {
    const cls = String(el.className || '').split(/\\s+/).filter(Boolean).sort().join('.');
    const skeleton = [];
    const walk = (node, depth) => {
      if (depth > 3) return;
      for (let i = 0; i < node.children.length; i++) {
        skeleton.push(depth + node.children[i].tagName.toLowerCase());
        walk(node.children[i], depth + 1);
      }
    };
    walk(el, 0);
    return el.tagName.toLowerCase() + '|' + cls + '|' + skeleton.join(',');
  };

  for (let i = 0; i < containers.length; i++) {
    const container = containers[i];
    const children = container.children;
    if (children.length < 2) continue;

    const counts = new Map();
    for (let c = 0; c < children.length; c++) {
      const sig = signature(children[c]);
      counts.set(sig, (counts.get(sig) || 0) + 1);
    }
    let bestSig = null;
    let bestCount = 0;
    counts.forEach((count, sig) => { if (count > bestCount) { bestCount = count; bestSig = sig; } });

    if (bestCount < 2 || bestCount / children.length < MIN_COVERAGE) continue;

    // A container whose repeating children are themselves containers of a
    // deeper repeat would be reported twice; keep the innermost, which is the
    // one whose items are the cards.
    let first = null;
    for (let c = 0; c < children.length; c++) {
      if (signature(children[c]) === bestSig) { first = children[c]; break; }
    }
    if (!first) continue;

    const style = getComputedStyle(container);
    const columns = style.gridTemplateColumns || '';
    const declared = (style.getPropertyValue('grid-template-columns') || '');
    const flexible = /auto-fit|auto-fill/.test(declared) || /auto-fit|auto-fill/.test(columns);

    out.push({
      containerTplId: container.getAttribute('data-tpl'),
      itemTplId: first.getAttribute('data-tpl'),
      itemCount: bestCount,
      flexibleCount: flexible,
      sampleText: (first.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      depth: (function () { let d = 0; for (let n = container; n; n = n.parentElement) d++; return d; })(),
    });
  }

  // Innermost wins where one repeater's container is inside another's item.
  return out
    .sort((a, b) => b.depth - a.depth)
    .filter((r, idx, arr) => !arr.slice(0, idx).some((other) =>
      document.querySelector('[data-tpl="' + other.containerTplId + '"]')
        ?.contains(document.querySelector('[data-tpl="' + r.containerTplId + '"]'))))
    .slice(0, 12);
})()`;

/**
 * The template's measurable identity: its accent, its polarity, its sections.
 *
 * The accent is found by looking at the buy button rather than by counting
 * colours in a stylesheet. That is exact where counting is a heuristic — v1's
 * colour detector returned Tailwind's transparent literal `#0000` as the
 * template's dominant ground because it matched literal values after
 * `background:` and a token-based stylesheet has almost none.
 */
export const MEASURE = `(function () {
  ${HELPERS}
  const CHECKOUT_HOSTS = /(gumroad|stripe|lemonsqueezy|lemonsqueezy|shopify|payhip|paddle|thrivecart|sendowl|podia|teachable|ko-fi|buymeacoffee|paypal)\\./i;

  // ── the buy buttons ──
  const anchors = Array.prototype.slice.call(document.querySelectorAll('a[href]'));
  const byHref = new Map();
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) continue;
    byHref.set(href, (byHref.get(href) || 0) + 1);
  }

  let ctas = anchors.filter((a) => CHECKOUT_HOSTS.test(a.getAttribute('href') || ''));
  if (ctas.length === 0) {
    // No recognised processor: the most repeated off-page link on a sales page
    // is its buy button.
    let topHref = null;
    let topCount = 1;
    byHref.forEach((count, href) => {
      if (count > topCount && /^https?:/i.test(href)) { topCount = count; topHref = href; }
    });
    if (topHref) ctas = anchors.filter((a) => a.getAttribute('href') === topHref);
  }
  if (ctas.length === 0) {
    // Last resort: the largest anchor that is styled like a button.
    const styled = anchors
      .map((a) => ({ a: a, s: getComputedStyle(a), r: a.getBoundingClientRect() }))
      .filter((x) => x.s.display !== 'inline' && x.r.width > 90 && x.r.height > 28 &&
                     x.s.backgroundColor && x.s.backgroundColor !== 'rgba(0, 0, 0, 0)')
      .sort((x, y) => y.r.width * y.r.height - x.r.width * x.r.height);
    if (styled.length > 0) ctas = styled.map((x) => x.a);
  }

  const ctaIds = ctas.map((a) => a.getAttribute('data-tpl')).filter(Boolean);
  // Whichever buy button actually PAINTS a background is the accent. The first
  // one in document order is frequently a plain text link in the header, whose
  // background is transparent — reading that one returned no accent at all, so
  // the theme adaptation had nothing to work from and silently did nothing.
  //
  // The background can also sit on a child (an anchor wrapping a styled span),
  // so each candidate's descendants are checked before moving on.
  let accentValue = null;
  let onAccentValue = null;
  for (let i = 0; i < ctas.length && !accentValue; i++) {
    const candidates = [ctas[i]].concat(Array.prototype.slice.call(ctas[i].querySelectorAll('*')).slice(0, 6));
    for (let c = 0; c < candidates.length; c++) {
      const style = getComputedStyle(candidates[c]);
      const painted = hex(style.backgroundColor);
      if (!painted) continue;
      accentValue = painted;
      onAccentValue = hex(style.color) || hex(getComputedStyle(ctas[i]).color);
      break;
    }
  }

  // ── :root tokens, resolved ──
  const rootStyle = getComputedStyle(document.documentElement);
  const rootTokens = {};
  for (let i = 0; i < rootStyle.length; i++) {
    const name = rootStyle[i];
    if (name.startsWith('--')) rootTokens[name] = rootStyle.getPropertyValue(name).trim();
  }
  // Which token IS the accent. Compared on resolved value, so a token defined
  // in oklch() and a computed rgb() still match.
  let accentToken = null;
  if (accentValue) {
    for (const name in rootTokens) {
      const resolved = rootTokens[name];
      if (!resolved) continue;
      const probe = document.createElement('span');
      probe.style.color = resolved;
      document.body.appendChild(probe);
      const asHex = hex(getComputedStyle(probe).color);
      probe.remove();
      if (asHex && asHex.toLowerCase() === accentValue.toLowerCase()) { accentToken = name; break; }
    }
  }

  // The FIRST element that actually paints a ground, walking outward-in.
  // document.body is very often transparent with the real background on <html>
  // or on a wrapper div — reading body alone reported this dark template as
  // light, which is the single most visible way a cloned page stops looking
  // like its template.
  let groundValue = null;
  const groundCandidates = [document.documentElement, document.body].concat(
    Array.prototype.slice.call(document.querySelectorAll('body > div, main, body > section')).slice(0, 4),
  );
  for (let i = 0; i < groundCandidates.length; i++) {
    const el = groundCandidates[i];
    if (!el) continue;
    const value = getComputedStyle(el).backgroundColor;
    if (toRgb(value)) { groundValue = value; break; }
  }
  const isDark = groundValue ? luminance(groundValue) < 0.4 : false;

  // ── typography, as the browser resolved it ──
  // Asked of the live page for the same reason the accent is: a stylesheet says
  // \`font-family: var(--font-display)\`, and only the browser knows that resolves
  // to DM Serif Display. Reading the declaration would repeat v1's mistake of
  // calling a serif page sans-serif because the token name contained no "serif".
  const firstFamily = (value) => {
    const first = String(value || '').split(',')[0] || '';
    return first.replace(/["']/g, '').trim();
  };
  // A generic keyword means the template never named a real face for this role,
  // so there is nothing to substitute and no fidelity to lose.
  const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z]+|-apple-system|inherit|initial)$/i;

  const roleFamily = (selectors) => {
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const rect = node.getBoundingClientRect();
        // Skip hidden nodes: a display:none heading in a closed mobile menu
        // still computes a family, and it is often not the one on the page.
        if (rect.width < 1 || rect.height < 1) continue;
        if (!(node.textContent || '').trim()) continue;
        const style = getComputedStyle(node);
        const family = firstFamily(style.fontFamily);
        if (!family || GENERIC.test(family)) continue;
        return {
          family: family,
          stack: style.fontFamily,
          weight: String(style.fontWeight || '400'),
          // Whether the RESOLVED face is a serif — measured, not guessed from
          // the name. Used to pick the fallback bucket when the face is lost.
          serif: /(^|,)\\s*["']?[^,]*serif/i.test(style.fontFamily) &&
                 !/sans-serif/i.test(String(style.fontFamily).split(',').pop() || ''),
        };
      }
    }
    return null;
  };

  const headingFont = roleFamily(['h1', 'h2', 'header h1', '[class*=title]', '[class*=heading]']);
  const bodyStyle = getComputedStyle(document.body);
  const bodyFamily = firstFamily(bodyStyle.fontFamily);
  const bodyFont = bodyFamily && !GENERIC.test(bodyFamily)
    ? { family: bodyFamily, stack: bodyStyle.fontFamily, weight: String(bodyStyle.fontWeight || '400'),
        serif: /serif/i.test(bodyStyle.fontFamily) && !/sans-serif/i.test(bodyStyle.fontFamily) }
    : roleFamily(['p', 'main p', 'li', 'body *']);

  // Every distinct real family the page paints, so the report can say which
  // ones were lost rather than only that "typography degraded".
  const familiesUsed = [];
  const seenFamily = new Set();
  const painted = document.querySelectorAll('body *');
  for (let i = 0; i < painted.length && familiesUsed.length < 12; i++) {
    const node = painted[i];
    if (!(node.textContent || '').trim()) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const family = firstFamily(getComputedStyle(node).fontFamily);
    if (!family || GENERIC.test(family)) continue;
    const key = family.toLowerCase();
    if (seenFamily.has(key)) continue;
    seenFamily.add(key);
    familiesUsed.push(family);
  }

  // ── sections ──
  const sections = [];
  const blocks = document.querySelectorAll('body > *, main > *, body > * > section, section, header, footer');
  const seen = new Set();
  for (let i = 0; i < blocks.length; i++) {
    const el = blocks[i];
    const tplId = el.getAttribute('data-tpl');
    if (!tplId || seen.has(tplId)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.height < 40) continue;
    seen.add(tplId);
    const style = getComputedStyle(el);
    sections.push({
      tplId: tplId,
      tag: el.tagName.toLowerCase(),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y + window.scrollY),
              width: Math.round(rect.width), height: Math.round(rect.height) },
      paddingBlock: [parseFloat(style.paddingTop) || 0, parseFloat(style.paddingBottom) || 0],
      background: hex(style.backgroundColor) || 'transparent',
    });
  }

  // ── content images that are not decoration ──
  const contentImages = [];
  const imgs = document.querySelectorAll('img');
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i];
    const rect = img.getBoundingClientRect();
    if (rect.width < 96 && rect.height < 96) continue;
    contentImages.push({
      tplId: img.getAttribute('data-tpl'),
      sourceUrl: img.currentSrc || img.src || '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }

  return {
    ctaIds: ctaIds,
    ctaCount: ctaIds.length,
    accentValue: accentValue,
    onAccentValue: onAccentValue,
    accentToken: accentToken,
    isDark: isDark,
    rootTokens: rootTokens,
    typography: { heading: headingFont, body: bodyFont, familiesUsed: familiesUsed },
    sections: sections,
    contentImages: contentImages,
    title: document.title || '',
  };
})()`;

/**
 * Every stylesheet the page actually applied, in document order.
 *
 * Reading `document.styleSheets` rather than fetching `<link>` tags is what
 * makes this work on a modern build. It picks up CSS-in-JS (styled-components
 * and emotion inject `<style>` elements, which are in this list), every chunk
 * of a code-split Tailwind bundle rather than the first three, and the actual
 * cascade order. Cross-origin sheets throw on `cssRules`; their href comes back
 * for the caller to fetch through the SSRF-guarded fetcher.
 */
export const COLLECT_CSS = `(function () {
  const sheets = [];
  const opaque = [];
  for (let i = 0; i < document.styleSheets.length; i++) {
    const sheet = document.styleSheets[i];
    try {
      const rules = sheet.cssRules;
      if (!rules) { if (sheet.href) opaque.push(sheet.href); continue; }
      const text = [];
      for (let r = 0; r < rules.length; r++) text.push(rules[r].cssText);
      sheets.push({ href: sheet.href || null, css: text.join('\\n') });
    } catch (e) {
      if (sheet.href) opaque.push(sheet.href);
    }
  }
  return { sheets: sheets, opaque: opaque };
})()`;

/** Absolute URLs of every image the page displays. */
export const COLLECT_IMAGE_URLS = `(function () {
  const urls = new Set();
  const imgs = document.querySelectorAll('img');
  for (let i = 0; i < imgs.length; i++) {
    const src = imgs[i].currentSrc || imgs[i].src;
    if (src && !src.startsWith('data:')) urls.add(src);
  }
  const all = document.querySelectorAll('body *');
  for (let i = 0; i < all.length; i++) {
    const bg = getComputedStyle(all[i]).backgroundImage;
    if (!bg || bg === 'none') continue;
    const matches = bg.match(/url\\((["']?)([^"')]+)\\1\\)/g) || [];
    for (const m of matches) {
      const inner = /url\\((["']?)([^"')]+)\\1\\)/.exec(m);
      if (inner && inner[2] && !inner[2].startsWith('data:')) urls.add(new URL(inner[2], location.href).href);
    }
  }
  // Array.from, NOT Array.prototype.slice.call: slice reads a length property,
  // which a Set does not have, so it silently returns an empty array. That is
  // exactly what it did — no image was ever re-hosted, and rewriteHtmlAssets
  // drops every img it has no local copy for, so a cloned page came back with
  // no images at all.
  return Array.from(urls);
})()`;

/**
 * Applies the placeholder map and converts repeaters, then serialises.
 *
 * Every entry whose `tplId` does not resolve is dropped and reported. That is
 * the guarantee: the annotation model returns ids, this resolves them, and an
 * id that names nothing does nothing. The model has no way to express a change
 * to the document because nothing it can say is markup.
 *
 * Takes its arguments as an injected JSON literal so the whole thing stays one
 * evaluatable expression.
 */
export function applyMapScript(payload: {
  placeholders: Array<{ tplId: string; placeholder: string; kind: string }>;
  repeaters: Array<{ key: string; containerTplId: string; itemTplId: string }>;
  optionalKeys: string[];
}): string {
  return `(function () {
  const payload = ${JSON.stringify(payload)};
  const applied = [];
  const dropped = [];
  const optional = new Set(payload.optionalKeys);

  // ── repeaters first ──
  // Before placeholders, because collapsing a repeater removes siblings that
  // would otherwise be carrying ids the map still refers to.
  for (const repeater of payload.repeaters) {
    const container = document.querySelector('[data-tpl="' + repeater.containerTplId + '"]');
    const item = document.querySelector('[data-tpl="' + repeater.itemTplId + '"]');
    if (!container || !item || item.parentElement !== container) { dropped.push(repeater.containerTplId); continue; }

    // Everything structurally like the kept item goes; anything else in the
    // container (a heading, a footnote) stays where the designer put it.
    const keepTag = item.tagName;
    const keepClass = String(item.className || '');
    const siblings = Array.prototype.slice.call(container.children);
    for (const sibling of siblings) {
      if (sibling === item) continue;
      if (sibling.tagName === keepTag && String(sibling.className || '') === keepClass) sibling.remove();
    }

    const holder = document.createElement('template');
    holder.setAttribute('data-repeat', repeater.key);
    item.replaceWith(holder);
    holder.appendChild(item);
    applied.push(repeater.containerTplId);
  }

  // ── placeholders ──
  for (const entry of payload.placeholders) {
    const el = document.querySelector('[data-tpl="' + entry.tplId + '"]');
    if (!el) { dropped.push(entry.tplId); continue; }
    const tokenText = '{{' + entry.placeholder + '}}';

    if (entry.kind === 'text' || entry.kind === 'html') {
      el.textContent = tokenText;
    } else if (entry.kind === 'src') {
      el.setAttribute('src', tokenText);
      // The slot was sized for the TEMPLATE's own artwork. A book cover is
      // 2:3 flat art; the template's product shots are 3D mockups at a
      // different ratio, and the template's CSS crops to fill — so the cover's
      // title ran off both edges. Marked here so the bound page can fit rather
      // than crop it. A letterboxed cover reads; a cropped title does not.
      el.setAttribute('data-fit', 'contain');
      // srcset would override src entirely, leaving the original image on the
      // page with a token sitting unused beside it.
      el.removeAttribute('srcset');
      el.removeAttribute('sizes');
      el.removeAttribute('loading');
      if (optional.has(entry.placeholder)) el.setAttribute('data-optional', entry.placeholder);
    } else if (entry.kind === 'href') {
      el.setAttribute('href', tokenText);
      el.setAttribute('rel', 'noopener nofollow');
      el.removeAttribute('target');
      el.removeAttribute('onclick');
    } else if (entry.kind === 'alt') {
      el.setAttribute('alt', tokenText);
    } else {
      dropped.push(entry.tplId);
      continue;
    }
    applied.push(entry.tplId);
  }

  return {
    html: '<!doctype html>\\n' + document.documentElement.outerHTML,
    appliedIds: applied,
    droppedIds: dropped,
  };
})()`;
}

/**
 * Finds collapsible regions — accordions, FAQ toggles, "read more" panels.
 *
 * These are the one piece of JavaScript-driven behaviour worth reproducing
 * rather than accepting the loss of. A sales page's FAQ is almost always an
 * accordion, and the usual construction ships every answer OPEN in the HTML and
 * lets a script collapse them on load. Strip the scripts and every answer is
 * expanded — which is what happened: the template shows six collapsed questions
 * and the cloned page showed six questions with all their prose beneath.
 *
 * Reported rather than converted here, because the conversion needs to know the
 * exact shape first: which node is the question, which is the answer, and
 * whether the pair is already a <details>.
 */
export const DETECT_COLLAPSIBLES = `(function () {
  const out = { native: 0, aria: [], candidates: [] };

  // Already native: nothing to do, these survive cleaning intact.
  out.native = document.querySelectorAll('details').length;

  // The accessible construction: a button says whether its panel is open.
  const controls = document.querySelectorAll('[aria-controls], [aria-expanded]');
  for (let i = 0; i < controls.length && out.aria.length < 12; i++) {
    const el = controls[i];
    const panelId = el.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    out.aria.push({
      tplId: el.getAttribute('data-tpl'),
      tag: el.tagName.toLowerCase(),
      expanded: el.getAttribute('aria-expanded'),
      controls: panelId,
      panelFound: Boolean(panel),
      panelTag: panel ? panel.tagName.toLowerCase() : null,
      panelVisible: panel ? getComputedStyle(panel).display !== 'none' : null,
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70),
    });
  }

  // The unlabelled construction, which is the common one: a repeated card whose
  // first child is a short line ending in "?" and whose sibling is the prose.
  const all = document.querySelectorAll('div, li, article, section');
  for (let i = 0; i < all.length && out.candidates.length < 12; i++) {
    const el = all[i];
    if (el.children.length < 2) continue;
    const head = el.children[0];
    const body = el.children[1];
    const headText = (head.textContent || '').replace(/\s+/g, ' ').trim();
    const bodyText = (body.textContent || '').replace(/\s+/g, ' ').trim();
    if (headText.length < 8 || headText.length > 120) continue;
    if (headText.indexOf('?') === -1) continue;
    if (bodyText.length < 40) continue;

    const bodyStyle = getComputedStyle(body);
    out.candidates.push({
      tplId: el.getAttribute('data-tpl'),
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 80),
      headTag: head.tagName.toLowerCase(),
      bodyTag: body.tagName.toLowerCase(),
      // Whether the answer is currently painted. All-visible on a page whose
      // template shows them closed is the signature of a script that collapses
      // on load and is no longer there to do it.
      bodyVisible: bodyStyle.display !== 'none' && parseFloat(bodyStyle.opacity) > 0.05,
      bodyMaxHeight: bodyStyle.maxHeight,
      question: headText.slice(0, 70),
    });
  }

  return out;
})()`;
