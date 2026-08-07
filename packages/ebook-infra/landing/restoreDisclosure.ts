/**
 * The styling a restored disclosure needs, and nothing else.
 *
 * The conversion itself happens in the browser during cleaning
 * (`RESTORE_DISCLOSURE` in `browserScripts.ts`), where a real DOM exists. It is
 * not done here by regex: an accordion row is nested same-tag `<div>`s, which
 * a non-greedy match cannot span — it stops at the first `</div>` and cuts the
 * row in half. Puppeteer is already open at capture time, so the parser is free.
 *
 * This constant lives on its own because the binder injects it into the head of
 * every page, and the browser script cannot reach across into the stylesheet.
 */

/**
 * `<details>` ships a disclosure triangle. The template's own chevron is still
 * in the trigger markup, so leaving the native marker shows two arrows.
 */
export const DISCLOSURE_CSS = `
details[data-restored] > summary{list-style:none;cursor:pointer;display:block}
details[data-restored] > summary::-webkit-details-marker{display:none}
details[data-restored] > summary::marker{content:""}
`;
