import type { AssembledDocument } from '@ebook/core';

/** Markdown→HTML for a professionally laid-out, book-style PDF. */
export function renderHtml(doc: AssembledDocument): string {
  const matter = (m: { title: string; content: string }) =>
    `<section class="matter"><h1>${esc(m.title)}</h1><p class="matter-ornament">···</p>${md(m.content)}</section>`;

  const frontMatter = doc.frontMatter.map(matter).join('\n');

  const toc = doc.tableOfContents.length
    ? `<section class="toc"><h1>Contents</h1><div class="toc__list">${doc.tableOfContents
        .map(
          (t, i) =>
            `<a class="toc__entry" href="#chap-${i}"><span class="toc__t">${i + 1}.&nbsp;&nbsp;${esc(t)}</span><span class="toc__dots"></span><span class="toc__pageno"></span></a>`,
        )
        .join('')}</div></section>`
    : '';

  const chapters = doc.chapters
    .map((c, i) => {
      const sections = c.sections.map((s) => `<h3>${esc(s.title)}</h3>${md(s.content)}`).join('\n');
      return (
        `<section class="chapter" id="chap-${i}">` +
        `<p class="chapter-eyebrow">Chapter ${i + 1}</p>` +
        `<h1 class="chapter-title">${esc(c.title)}</h1>` +
        `<p class="chapter-ornament">···</p>` +
        `${renderBody(c.content, c.illustrations)}${sections}</section>`
      );
    })
    .join('\n');

  const backMatter = doc.backMatter.map(matter).join('\n');

  // Page 1 — the AI-generated cover. The full premium design (incl. the title
  // typography) is rendered INTO the image, so we show it full-bleed with no
  // overlay at all — the artwork IS the cover. The subtitle lives on the title
  // page only; overlaying it here collided with the baked-in title art.
  const coverArt = doc.coverImage
    ? `<section class="cover--art cover--full" style="background-image:url('${esc(doc.coverImage)}')"></section>`
    : '';

  // Title page — the classic typographic page carrying the actual book title.
  // Always present; it is page 1 when there is no cover art, page 2 otherwise.
  const titlePage = `<section class="title-page">
      <h1 class="title-page__title">${esc(doc.title)}</h1>
      ${doc.subtitle ? `<p class="title-page__subtitle">${esc(doc.subtitle)}</p>` : ''}
      ${doc.promise ? `<p class="title-page__promise">${esc(doc.promise)}</p>` : ''}
      <p class="title-page__ornament">···</p>
      <p class="title-page__author">${esc(doc.author)}</p>
    </section>`;

  // Closing page (only when a cover was generated): a clean navy "About This Book"
  // page. It does NOT reuse the cover artwork — that now carries the baked-in title,
  // so reusing it would read as a second front cover.
  const backCover = doc.coverImage
    ? `<section class="cover--art cover--back">
        <div class="cover__scrim"></div>
        <div class="cover__inner">
          <p class="cover__eyebrow">About This Book</p>
          <h2 class="cover__back-title">${esc(doc.title)}</h2>
          ${doc.subtitle ? `<p class="cover__overview-lead">${esc(doc.subtitle)}</p>` : ''}
          ${doc.promise ? `<p class="cover__overview">${esc(doc.promise)}</p>` : ''}
          <p class="cover__back-author">${esc(doc.author)}</p>
        </div>
      </section>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page {
      size: A4; margin: 25mm;
      @top-center {
        content: "${cssString(doc.title)}";
        font-family: 'Georgia', serif; font-size: 8pt; letter-spacing: 0.18em; text-transform: uppercase; color: #c2c2c2;
      }
      /* Page number on every page. The full-bleed cover has margin:0, so its
         margin boxes have no room and it stays unnumbered — every other page shows
         its own number. */
      @bottom-center {
        content: counter(page);
        font-family: 'Georgia', serif; font-size: 9pt; color: #999;
      }
    }
    /* Running header suppressed on the cover, title page, and the first page of each chapter.
       Named pages must restate size:A4 — otherwise Paged.js sizes their sheet to its default
       (US Letter), leaving the A4 cover art short of the page edges. */
    @page cover { size: A4; margin: 0; @top-center { content: none; } }
    @page title { size: A4; margin: 25mm; @top-center { content: none; } }
    @page chapter { size: A4; margin: 25mm; }
    @page chapter:first { @top-center { content: none; } }
    html { -webkit-print-color-adjust: exact; }
    body { margin: 0; font-family: 'Georgia', 'Times New Roman', serif; font-size: 12pt; line-height: 1.65; color: #1a1a1a; }
    p { margin: 0 0 0.85em; text-align: justify; hyphens: auto; }
    strong { font-weight: 700; }
    em { font-style: italic; }

    h1, h2, h3 { font-family: 'Georgia', serif; color: #111; line-height: 1.25; }
    h2 { font-size: 15pt; margin: 1.5em 0 0.5em; }
    h3 { font-size: 12.5pt; margin: 1.3em 0 0.4em; }

    ul, ol { margin: 0 0 0.9em; padding-left: 1.4em; }
    li { margin: 0 0 0.35em; text-align: left; }
    ol.steps li { padding-left: 0.25em; }

    /* Each major part starts on a fresh page. */
    .matter, .toc, .chapter { page-break-before: always; }

    /* Front/back matter (Preface, Conclusion, …) — centered small-caps header + drop-cap body */
    .matter { padding-top: 22mm; }
    .matter h1 { text-align: center; text-transform: uppercase; letter-spacing: 0.25em; font-weight: 600; font-size: 18pt; color: #555; margin: 0 0 0.5em; }
    .matter-ornament { text-align: center; color: #bbb; letter-spacing: 0.4em; margin: 0 0 1.8em; }
    .matter-ornament + p::first-letter,
    .chapter-ornament + p::first-letter {
      float: left; font-family: 'Georgia', serif; font-weight: 700; font-size: 3.4em; line-height: 0.74;
      padding: 0.02em 0.08em 0 0; color: #1a1a1a;
    }

    /* Table of contents — centered heading; entries with dot-leader page numbers */
    .toc { text-align: center; padding-top: 14mm; }
    .toc h1 { text-align: center; text-transform: uppercase; letter-spacing: 0.25em; font-weight: 600; font-size: 18pt; margin: 0 0 1.6em; }
    .toc__list { max-width: 34em; margin: 0 auto; text-align: left; }
    .toc__entry { display: flex; align-items: baseline; color: #1a1a1a; text-decoration: none; margin: 0.55em 0; line-height: 1.4; }
    .toc__dots { flex: 1 1 auto; border-bottom: 1px dotted #c0c0c0; margin: 0 0.5em; transform: translateY(-0.18em); }
    .toc__pageno { color: #888; white-space: nowrap; }

    /* Title page — typographic, carries the actual book title; vertically centered on its page */
    .title-page { page: title; text-align: center; height: 247mm; display: flex; flex-direction: column; justify-content: center; }
    /* overflow-wrap guarantees even an unbroken token (e.g. a pasted FILE_NAME_TITLE)
       breaks instead of running off the page; max-width keeps normal titles centered. */
    .title-page__title { font-size: 30pt; font-weight: 700; letter-spacing: -0.5px; margin: 0 auto; line-height: 1.15; max-width: 22em; overflow-wrap: break-word; word-wrap: break-word; hyphens: auto; }
    .title-page__subtitle { font-size: 14pt; font-style: italic; color: #555; margin: 16px auto 0; max-width: 30em; }
    .title-page__promise { font-size: 12pt; font-style: italic; color: #777; margin: 12px auto 0; max-width: 28em; }
    .title-page__ornament { text-align: center; color: #aaa; letter-spacing: 0.4em; margin: 22px 0; }
    .title-page__author { text-align: center; margin: 8mm auto 0; font-size: 13pt; letter-spacing: 0.5px; color: #333; }

    /* Cover — full-bleed generated art. Heavy scrim + shadows guarantee the title
       stays legible no matter how light or busy the generated illustration is. */
    .cover--art { page: cover; break-after: page; position: relative; width: 210mm; height: 297mm; margin: 0; padding: 0;
      color: #fff; text-align: left; background-color: #0b1220; background-size: cover; background-position: center; }
    /* Front cover: show the WHOLE generated cover (incl. baked-in title) — 'contain'
       never crops an edge; the navy page colour hides the thin side bars. */
    .cover--full { background-size: contain !important; background-repeat: no-repeat; }
    .cover--art .cover__scrim { position: absolute; inset: 0;
      background: linear-gradient(180deg, rgba(7,12,22,.88) 0%, rgba(7,12,22,.52) 30%, rgba(7,12,22,.52) 60%, rgba(7,12,22,.92) 100%); }
    /* Inner splits the page: idea on the TOP half, promise + byline on the BOTTOM half */
    .cover--art .cover__inner { position: relative; z-index: 1; box-sizing: border-box; height: 100%;
      padding: 24mm 20mm; display: flex; flex-direction: column; justify-content: space-between; }
    .cover--art .cover__eyebrow { text-transform: uppercase; letter-spacing: 3px; font-size: 10pt; font-weight: 700;
      color: #ff8a3d; margin: 0; text-shadow: 0 1px 6px rgba(0,0,0,.8); }
    /* Front cover headline = the book's main idea/topic (NOT the title), on the top half */
    .cover--art .cover__idea { font-family: 'Georgia', serif; font-size: 34pt; font-weight: 700; line-height: 1.15;
      color: #ffffff; margin: 0; max-width: 18em; text-shadow: 0 2px 18px rgba(0,0,0,.95), 0 0 2px rgba(0,0,0,.9); }
    .cover--art .cover__promise { font-size: 12pt; font-style: italic; color: #f0f0f0; margin: 0 0 5mm; max-width: 30em;
      text-shadow: 0 1px 10px rgba(0,0,0,.85); }
    .cover--art .cover__byline { text-transform: uppercase; letter-spacing: 2px; font-size: 10.5pt; font-weight: 600;
      color: #ff8a3d; margin: 0; text-shadow: 0 1px 8px rgba(0,0,0,.85); }

    /* Back cover — same art, vertically-centered book overview */
    .cover--back { page-break-before: always; }
    .cover--back .cover__inner { justify-content: center; align-items: center; text-align: center; }
    .cover--art .cover__back-title { font-family: 'Georgia', serif; font-size: 26pt; font-weight: 700; color: #ffffff;
      margin: 0 0 8mm; text-shadow: 0 2px 16px rgba(0,0,0,.95); overflow-wrap: break-word; word-wrap: break-word; }
    .cover--art .cover__overview-lead { font-size: 14pt; color: #ff8a3d; font-weight: 600; margin: 0 0 5mm; max-width: 28em;
      text-shadow: 0 1px 8px rgba(0,0,0,.85); }
    .cover--art .cover__overview { font-size: 12.5pt; color: #f3f3f3; line-height: 1.7; margin: 0 0 10mm; max-width: 30em;
      text-align: center; text-shadow: 0 1px 10px rgba(0,0,0,.85); }
    .cover--art .cover__back-author { text-transform: uppercase; letter-spacing: 2px; font-size: 10pt; color: #e9e9e9;
      text-shadow: 0 1px 8px rgba(0,0,0,.85); }

    /* Chapters — centered opener (eyebrow + title + ornament), justified body */
    .chapter { page: chapter; padding-top: 22mm; }
    .chapter-eyebrow { text-align: center; text-transform: uppercase; letter-spacing: 0.25em; font-size: 11pt; font-weight: 600; color: #8a8a8a; margin: 0 0 1.2em; }
    .chapter-title { text-align: center; font-size: 24pt; font-weight: 700; margin: 0 auto 0.4em; max-width: 18em; line-height: 1.2; page-break-after: avoid; overflow-wrap: break-word; word-wrap: break-word; }
    .chapter-ornament { text-align: center; color: #bbb; letter-spacing: 0.4em; margin: 0 0 1.6em; page-break-after: avoid; }

    /* In-chapter illustrations — a partial-page, centered inset that flows with the
       text (NOT a full page), and never splits across a page break. */
    figure.illustration { margin: 1.7em 0; text-align: center; page-break-inside: avoid; break-inside: avoid; }
    figure.illustration img { display: block; width: 76%; max-width: 125mm; max-height: 95mm;
      margin: 0 auto; object-fit: contain; border-radius: 5px; box-shadow: 0 1px 6px rgba(0,0,0,.12); }
  </style></head><body>
    ${coverArt}
    ${titlePage}
    ${frontMatter}
    ${toc}
    ${chapters}
    ${backMatter}
    ${backCover}
  </body></html>`;
}

/** Minimal block-level Markdown: headings, bullet/numbered/checkbox lists, paragraphs. */
function md(text: string): string {
  return renderBlocks(text).join('\n');
}

/** Render markdown to one HTML string per block (so figures can be interleaved). */
function renderBlocks(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((block) => {
      const t = block.trim();
      if (!t) return '';
      if (t.startsWith('### ')) return `<h3>${inline(esc(t.slice(4)))}</h3>`;
      if (t.startsWith('## ')) return `<h2>${inline(esc(t.slice(3)))}</h2>`;
      if (t.startsWith('# ')) return `<h2>${inline(esc(t.slice(2)))}</h2>`;

      const lines = t.split('\n');
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        const items = lines
          .map((l) => `<li>${inline(esc(l.replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, '')))}</li>`)
          .join('');
        return `<ul>${items}</ul>`;
      }
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        const items = lines.map((l) => `<li>${inline(esc(l.replace(/^\s*\d+[.)]\s+/, '')))}</li>`).join('');
        return `<ol class="steps">${items}</ol>`;
      }
      return `<p>${inline(esc(t.replace(/\n/g, ' ')))}</p>`;
    })
    .filter(Boolean);
}

/**
 * Render a chapter body with its illustrations spread evenly across the
 * paragraphs. Each figure is inserted AFTER an interior block at position
 * (k+1)/(M+1) of the body, so the art lands beside the passage it depicts and
 * never opens or closes the chapter.
 */
function renderBody(content: string, illustrations?: Array<{ dataUri: string; alt: string }>): string {
  const blocks = renderBlocks(content);
  const figs = illustrations ?? [];
  if (figs.length === 0 || blocks.length === 0) return blocks.join('\n');

  const positions = figs.map((_, k) =>
    Math.min(blocks.length, Math.max(1, Math.round(((k + 1) / (figs.length + 1)) * blocks.length))),
  );
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    out.push(blocks[i]!);
    figs.forEach((f, k) => {
      if (positions[k] === i + 1) {
        out.push(`<figure class="illustration"><img src="${esc(f.dataUri)}" alt="${esc(f.alt)}"></figure>`);
      }
    });
  }
  return out.join('\n');
}

function inline(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape a string for use inside a CSS double-quoted string (e.g. @top-center content). */
function cssString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
}
