import { type AssembledDocument, parseRecipe, type Recipe } from '@ebook/core';

/**
 * Vintage cookbook layout — styled after the 1971 Betty Crocker recipe cards
 * (aged cream paper, retro palette, a title/category banner, two-column
 * ingredients, paragraph instructions, and a spoon serving-tip), applied to a
 * BOOK format (cover, contents, recipe pages, back matter). Each chapter carries
 * one recipe serialized as JSON in `content`; we parse it here.
 */
export function renderCookbookHtml(doc: AssembledDocument): string {
  const coverArt = doc.coverImage
    ? `<section class="cover--art cover--full" style="background-image:url('${esc(doc.coverImage)}')"></section>`
    : '';

  const titlePage = `<section class="title-page">
      <p class="title-page__eyebrow">The Recipe Collection</p>
      <div class="title-page__rule"></div>
      <h1 class="title-page__title">${esc(doc.title)}</h1>
      ${doc.subtitle ? `<p class="title-page__subtitle">${esc(doc.subtitle)}</p>` : ''}
      <div class="title-page__rule"></div>
      <p class="title-page__author">${esc(doc.author)}</p>
    </section>`;

  const toc = doc.tableOfContents.length
    ? `<section class="toc"><h1>Recipes</h1><div class="toc__list">${doc.tableOfContents
        .map(
          (t, i) =>
            `<a class="toc__entry" href="#chap-${i}"><span class="toc__t">${esc(t)}</span><span class="toc__dots"></span><span class="toc__pageno"></span></a>`,
        )
        .join('')}</div></section>`
    : '';

  const recipes = doc.chapters
    .map((c, i) => {
      const recipe = parseRecipe(c.content);
      const photo = c.illustrations?.[0]?.dataUri;
      return recipe ? renderRecipe(recipe, i, photo) : renderRecipeFallback(c.title, c.content, i);
    })
    .join('\n');

  const backMatter = doc.backMatter
    .map((m) => `<section class="matter"><h1>${esc(m.title)}</h1><div class="matter__rule"></div>${paras(m.content)}</section>`)
    .join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    /* ── Vintage palette ─────────────────────────────────────────────────────
       cream paper #f4ead2 · deep avocado #4a5223 · mustard #c08a2d ·
       barn red #9c3b28 · warm brown ink #3d2f22 */
    @page { size: A4; margin: 16mm;
      @bottom-center { content: counter(page); font-family: 'Georgia', serif; font-size: 9pt; color: #9c8a63; } }
    @page cover { size: A4; margin: 0; @bottom-center { content: none; } }
    @page recipe { size: A4; margin: 0; @bottom-center { content: none; } }
    html { -webkit-print-color-adjust: exact; }
    body { margin: 0; font-family: 'Georgia', 'Times New Roman', serif; font-size: 10.5pt; line-height: 1.5;
      color: #3d2f22; background: #f4ead2; }
    h1, h2, h3 { margin: 0; }

    /* Title page — cream, framed, letterpress feel */
    .title-page { page: recipe; text-align: center; height: 297mm; display: flex; flex-direction: column;
      justify-content: center; padding: 0 26mm; box-sizing: border-box; background: #f4ead2; }
    .title-page__eyebrow { text-transform: uppercase; letter-spacing: 0.35em; font-size: 11pt; color: #9c3b28; margin-bottom: 6mm; }
    .title-page__title { font-family: 'Georgia', serif; font-size: 34pt; font-weight: 700; line-height: 1.1;
      color: #4a5223; letter-spacing: 0.02em; }
    .title-page__subtitle { font-size: 13pt; font-style: italic; color: #7a6a4a; margin-top: 5mm; }
    .title-page__rule { width: 46mm; height: 2px; background: #c08a2d; margin: 8mm auto; }
    .title-page__author { font-size: 12pt; text-transform: uppercase; letter-spacing: 0.22em; color: #6a5636; }

    /* Cover — full-bleed generated art */
    .cover--art { page: cover; break-after: page; position: relative; width: 210mm; height: 297mm; margin: 0;
      color: #fff; background-color: #4a5223; background-size: cover; background-position: center; }
    .cover--full { background-size: contain !important; background-repeat: no-repeat; }

    /* Contents */
    .toc { page-break-before: always; padding-top: 18mm; }
    .toc h1 { font-family: 'Georgia', serif; text-align: center; text-transform: uppercase; letter-spacing: 0.22em;
      font-weight: 700; font-size: 22pt; color: #9c3b28; margin-bottom: 1.4em; }
    .toc__list { max-width: 36em; margin: 0 auto; }
    .toc__entry { display: flex; align-items: baseline; color: #3d2f22; text-decoration: none; margin: 0.5em 0; }
    .toc__dots { flex: 1 1 auto; border-bottom: 1px dotted #b7a175; margin: 0 0.5em; transform: translateY(-0.18em); }
    .toc__pageno { color: #9c8a63; }

    /* ── Recipe page — vintage card ──────────────────────────────────────────
       A cream page with a printed inner border, a banner (title left, category
       right), the dish photo, two-column ingredients, paragraph method, and a
       spoon serving-tip. */
    /* One recipe = one page. Fixed-height card that never splits across a page
       break (which broke the frame on continuation pages). A content-heavy recipe
       is auto-scaled by the fit script below so it fits WITHOUT clipping. */
    .recipe { page: recipe; page-break-before: always; position: relative; width: 210mm; height: 297mm;
      box-sizing: border-box; background: #f4ead2; padding: 12mm; overflow: hidden; }
    /* Flex column so the banner pins to the top and the content region below it can
       stretch to fill the card — no dead band at the bottom for short recipes. */
    .recipe__card { border: 1.5px solid #4a5223; box-sizing: border-box; height: 273mm; padding: 9mm 10mm 11mm;
      position: relative; break-inside: avoid; page-break-inside: avoid;
      display: flex; flex-direction: column; background:
        repeating-linear-gradient(0deg, rgba(74,82,35,0.015) 0, rgba(74,82,35,0.015) 1px, transparent 1px, transparent 5px); }
    /* Scalable content region (everything under the banner). Uses zoom (not
       transform: scale) because zoom actually REFLOWS and reduces the laid-out
       height, so a shrunk recipe genuinely takes less space and can't overflow the
       card; transform:scale only shrinks visually while keeping its original height.
       flex:1 lets it claim the full card height; space-between then spreads the slack
       between the top content and the serving tip so any residual gap reads as
       intentional breathing room, not a broken empty band. The fit script (in the PDF
       exporter) additionally zooms the whole region up/down so most recipes fill
       naturally before this distribution even applies. */
    .recipe__fit { zoom: var(--fit, 1); flex: 1 1 auto; min-height: 0;
      display: flex; flex-direction: column; justify-content: space-between; }
    /* The tip anchors to the bottom of the fit region; the block above it holds the
       photo/ingredients/method and takes its natural height at the top. */
    .recipe__body { display: block; }

    /* Banner: title (left) + category & number (right) with a rule underneath */
    .recipe__banner { display: flex; justify-content: space-between; align-items: flex-end;
      border-bottom: 2px solid #9c3b28; padding-bottom: 2.5mm; margin-bottom: 6mm; }
    .recipe__title { font-family: 'Georgia', serif; font-size: 19pt; font-weight: 700; letter-spacing: 0.06em;
      text-transform: uppercase; color: #4a5223; line-height: 1.1; }
    .recipe__category { text-align: right; text-transform: uppercase; letter-spacing: 0.18em; font-size: 9pt;
      font-style: italic; color: #9c3b28; white-space: nowrap; padding-bottom: 1mm; }
    .recipe__category b { font-style: normal; font-size: 13pt; margin-left: 3mm; color: #4a5223; }

    /* Dish photo — framed with a thin retro border */
    .recipe__photo { display: block; width: 100%; height: 74mm; object-fit: cover; border: 3px solid #fff;
      outline: 1px solid #6a5636; margin-bottom: 5mm; }
    .recipe__photo--empty { width: 100%; height: 40mm; margin-bottom: 6mm; border: 1px solid #6a5636;
      background: repeating-linear-gradient(45deg,#e7d9b6,#e7d9b6 8px,#efe2c2 8px,#efe2c2 16px); }
    /* Salvaged text when a recipe's structured content failed to parse. */
    .recipe__fallback { color: #4a3f28; font-size: 10.5pt; line-height: 1.5; }
    .recipe__fallback p { margin: 0 0 3mm; }
    .recipe__fallback-list { margin: 0; padding-left: 6mm; }
    .recipe__fallback-list li { margin-bottom: 1.5mm; }

    .recipe__desc { font-style: italic; color: #6a5636; text-align: center; margin-bottom: 4mm; font-size: 10pt; line-height: 1.35; }

    /* Meta line: servings · prep · cook, small caps */
    .recipe__meta { text-align: center; text-transform: uppercase; letter-spacing: 0.14em; font-size: 8.5pt;
      color: #6a5636; margin-bottom: 4.5mm; }
    .recipe__meta b { color: #9c3b28; }
    .recipe__meta span { margin: 0 4mm; }

    /* Ingredients — two columns, like the card */
    .recipe__section-label { font-family: 'Georgia', serif; text-transform: uppercase; letter-spacing: 0.16em;
      font-size: 11pt; font-weight: 700; color: #9c3b28; text-align: center; margin: 0 0 3mm;
      border-top: 1px solid #c9b489; border-bottom: 1px solid #c9b489; padding: 1.3mm 0; }
    .recipe__ingredients { column-count: 2; column-gap: 10mm; margin-bottom: 4.5mm; }
    .recipe__ingredients ul { list-style: none; margin: 0; padding: 0; }
    .recipe__ingredients li { font-size: 9.5pt; padding: 0.4mm 0; break-inside: avoid; line-height: 1.3; }
    .recipe__ingredients li::before { content: '•'; color: #c08a2d; margin-right: 2mm; }

    /* Method — running paragraphs (numbered inline like the vintage cards) */
    .recipe__method p { margin: 0 0 2mm; text-align: justify; hyphens: auto; line-height: 1.42; }
    .recipe__method .step-label { font-weight: 700; color: #4a5223; }

    /* Serving tip — spoon icon + italic note, echoing the card footer */
    .recipe__tip { display: flex; align-items: flex-start; gap: 3mm; margin-top: 5mm; padding-top: 3.5mm;
      border-top: 1px solid #c9b489; font-style: italic; font-size: 9pt; color: #6a5636; line-height: 1.35; }
    .recipe__tip-icon { flex: 0 0 auto; color: #c08a2d; font-size: 13pt; line-height: 1; }

    /* Back matter */
    .matter { page-break-before: always; padding-top: 22mm; text-align: center; }
    .matter h1 { font-family: 'Georgia', serif; text-transform: uppercase; letter-spacing: 0.22em; font-weight: 700;
      font-size: 18pt; color: #9c3b28; }
    .matter__rule { width: 40mm; height: 2px; background: #c08a2d; margin: 4mm auto 7mm; }
    .matter p { margin: 0 auto 0.8em; max-width: 32em; text-align: left; }
  </style></head><body>
    ${coverArt}
    ${titlePage}
    ${toc}
    ${recipes}
    ${backMatter}
  </body></html>`;
}

function renderRecipe(r: Recipe, index: number, photo?: string): string {
  const category = inferCategory(r);
  const photoEl = photo
    ? `<img class="recipe__photo" src="${esc(photo)}" alt="${esc(r.title)}">`
    : `<div class="recipe__photo--empty"></div>`;
  const ingredients = r.ingredients.map((i) => `<li>${esc(i)}</li>`).join('');
  // Vintage cards run the method as prose with a leading bold cue per step.
  const method = r.instructions
    .map((s) => `<p>${s.label ? `<span class="step-label">${esc(s.label)}.</span> ` : ''}${esc(s.text)}</p>`)
    .join('');
  const tip = r.tips.length
    ? `<div class="recipe__tip"><span class="recipe__tip-icon">&#127860;</span><span>${r.tips
        .map((t) => esc(t))
        .join(' ')}</span></div>`
    : '';
  // The banner stays fixed at the top of the card; everything below sits in a
  // `.recipe__fit` box that a small script auto-scales down if a content-heavy
  // recipe would otherwise overflow the fixed card height (so nothing is clipped).
  return (
    `<section class="recipe" id="chap-${index}"><div class="recipe__card">` +
    `<div class="recipe__banner">` +
    `<h1 class="recipe__title">${esc(r.title)}</h1>` +
    `<div class="recipe__category">${esc(category)}<b>${index + 1}</b></div>` +
    `</div>` +
    `<div class="recipe__fit">` +
    `<div class="recipe__body">` +
    photoEl +
    (r.description ? `<p class="recipe__desc">${esc(r.description)}</p>` : '') +
    `<div class="recipe__meta">` +
    `<span>Makes <b>${r.servings}</b> servings</span>·` +
    `<span>Prep <b>${r.prepTimeMinutes} min</b></span>·` +
    `<span>Cook <b>${r.cookTimeMinutes} min</b></span>` +
    `</div>` +
    `<div class="recipe__section-label">Ingredients</div>` +
    `<div class="recipe__ingredients"><ul>${ingredients}</ul></div>` +
    `<div class="recipe__section-label">Directions</div>` +
    `<div class="recipe__method">${method}</div>` +
    `</div>` +
    tip +
    `</div>` +
    `</div></section>`
  );
}

/** A vintage-style category label from the recipe's own cuisine/keywords. */
function inferCategory(r: Recipe): string {
  const t = `${r.title} ${r.description}`.toLowerCase();
  if (/cake|cookie|pie|dessert|sweet|brownie|tart|pudding|ice cream/.test(t)) return 'Desserts';
  if (/soup|stew|chowder|broth/.test(t)) return 'Soups';
  if (/salad/.test(t)) return 'Salads';
  if (/bread|roll|biscuit|muffin|scone|brioche/.test(t)) return 'Breads';
  if (/drink|smoothie|cocktail|juice|latte/.test(t)) return 'Beverages';
  if (/appetizer|dip|snack|starter/.test(t)) return 'Appetizers';
  return 'Main Dishes';
}

/**
 * Rendered only when a recipe chapter's content did NOT parse into a Recipe (e.g.
 * truncated/malformed JSON). Rather than ship a blank card with just a title, we
 * salvage whatever readable text is in the content — recovered ingredient/step
 * strings from partial JSON, or the raw prose — so the page is never empty.
 */
function renderRecipeFallback(title: string, content: string | null | undefined, index: number): string {
  const salvaged = salvageRecipeText(content);
  const body = salvaged
    ? `<div class="recipe__fallback">${salvaged}</div>`
    : '<div class="recipe__photo--empty"></div>';
  return `<section class="recipe" id="chap-${index}"><div class="recipe__card"><div class="recipe__banner"><h1 class="recipe__title">${esc(title)}</h1></div>${body}</div></section>`;
}

/**
 * Pull human-readable lines out of an unparseable recipe content string. Handles
 * the common case of truncated recipe JSON (grab the quoted strings that look like
 * ingredients/steps) and plain prose (show it as paragraphs). Returns '' if there
 * is nothing worth showing.
 */
function salvageRecipeText(content: string | null | undefined): string {
  if (!content) return '';
  const cleaned = content.replace(/<!--recipe-->/g, '').trim();
  if (!cleaned) return '';
  // If it looks like JSON, extract the quoted string values (ingredients, step
  // text, description) — these carry the actual recipe words even when the JSON
  // is truncated and won't parse.
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    const strings = [...cleaned.matchAll(/"([^"\\]{3,}?)"/g)]
      .map((m) => (m[1] ?? '').trim())
      // Drop the JSON KEYS (title, ingredients, …) — keep the human values.
      .filter((s) => !/^(title|description|servings|prepTimeMinutes|cookTimeMinutes|ingredients|instructions|label|text|tips)$/.test(s));
    const items = [...new Set(strings)];
    if (items.length === 0) return '';
    return `<ul class="recipe__fallback-list">${items.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`;
  }
  // Plain prose — render as paragraphs.
  const paras = cleaned.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length === 0) return '';
  return paras.map((p) => `<p>${esc(p)}</p>`).join('');
}

/** Minimal paragraph splitter for back-matter prose. */
function paras(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p.replace(/\n/g, ' '))}</p>`)
    .join('');
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
