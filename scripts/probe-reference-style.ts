/**
 * Prints the style digest read from a reference sales page.
 *
 * This is what the landing-page layout call is TOLD the reference looks like —
 * the fonts, the grounds, the accent, the measure. When a generated page comes
 * back looking nothing like the site it was meant to follow, this says whether
 * the page was read wrong or the model ignored what it was given, which is
 * otherwise only distinguishable by regenerating and guessing.
 *
 *   npx tsx scripts/probe-reference-style.ts https://example.com/
 *
 * Costs nothing: it fetches the page and its stylesheets, and calls no model.
 */
import { HttpReferencePageFetcher } from '../packages/ebook-infra/net/HttpReferencePageFetcher';
async function main() {
  const url = process.argv[2] ?? 'https://vintagelifestyleusa.com/';
  const r = await new HttpReferencePageFetcher().fetch(url);
  if (r.isFail()) { console.error(r.error); process.exit(1); }
  console.log(url);
  console.log(JSON.stringify(r.value.style, null, 2));
}
main();
