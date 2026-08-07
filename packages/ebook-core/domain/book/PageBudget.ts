import { ValueObject } from '../shared/ValueObject';

/** Translates a page target into word budgets used to size chapters. */
export class PageBudget extends ValueObject<{ pages: number }> {
  // Converts the page target into a word budget. LOWER it → fewer words → fewer
  // finished pages; RAISE it → more. Calibrated against real renders (~300 words
  // per FINISHED page, once chapter openers, mid-chapter page breaks and front
  // matter are counted) together with chapters now respecting their target length
  // (ChapterPrompt no longer forces oversized chapters). Tuned to land a 100-page
  // target at ~100–115 finished pages.
  static readonly WORDS_PER_PAGE = 280;

  static of(pages: number): PageBudget {
    return new PageBudget({ pages });
  }

  get pages(): number {
    return this.props.pages;
  }

  totalWords(): number {
    return this.props.pages * PageBudget.WORDS_PER_PAGE;
  }

  /** ~100 pages → ~28,000 words → 14 chapters × ~2,000 words. */
  perChapterWords(chapterCount: number): number {
    if (chapterCount <= 0) return 0;
    return Math.round(this.totalWords() / chapterCount);
  }

  static pagesFromWords(words: number): number {
    return Math.ceil(words / PageBudget.WORDS_PER_PAGE);
  }
}
