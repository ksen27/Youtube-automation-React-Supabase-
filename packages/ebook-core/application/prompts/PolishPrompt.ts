export interface PolishEdit {
  /** A verbatim, contiguous substring of the chapter to replace. Must be unique. */
  find: string;
  /** The improved text to substitute in its place. */
  replace: string;
}

export const PolishPrompt = {
  /**
   * Per-chapter polishing pass (Phase 12) as TARGETED EDITS rather than a full
   * rewrite. The model returns only the spans it wants to change, so output is a
   * handful of small edits instead of re-emitting the whole chapter — far fewer
   * output tokens, hence much faster and cheaper per chapter.
   */
  system(input: { tone: string; authorVoice: string }) {
    return (
      'You are a senior book editor performing a final polish on one chapter. ' +
      `Maintain a consistent ${input.tone} tone and this author voice: ${input.authorVoice}. ` +
      'Goals: remove repetition, improve flow and transitions, ensure logical progression, ' +
      'and improve readability. Do NOT shorten substantially, remove sections, or alter Markdown headings.\n\n' +
      'Return ONLY a JSON object of surgical edits — never the full chapter. Schema:\n' +
      '{"edits":[{"find":"<verbatim text to replace>","replace":"<improved text>"}]}\n\n' +
      'Rules for each edit:\n' +
      '- "find" MUST be copied byte-for-byte from the chapter (exact spelling, punctuation, whitespace).\n' +
      '- "find" MUST be unique in the chapter; if a phrase repeats, extend it with surrounding context until it is unique.\n' +
      '- Keep each "find" span as small as the change requires (a phrase, sentence, or two — not whole paragraphs).\n' +
      '- Do not include Markdown headings inside "find".\n' +
      '- If the chapter already reads well, return {"edits":[]}.\n' +
      'Output strictly the JSON object with no prose, no Markdown fences.'
    );
  },
  user(input: { title: string; content: string; previousChapterTitle: string | null }) {
    return (
      (input.previousChapterTitle
        ? `This chapter follows "${input.previousChapterTitle}"; ensure a smooth handoff.\n\n`
        : '') +
      `Chapter "${input.title}":\n\n${input.content}`
    );
  },

  /**
   * Parse the model's edit response. Tolerates accidental ```json fences and
   * surrounding prose by extracting the outermost JSON object. Returns [] for
   * anything unparseable so a malformed response degrades to "no change" rather
   * than blocking the pipeline.
   */
  parseEdits(raw: string): PolishEdit[] {
    const json = extractJsonObject(raw);
    if (!json) return [];
    try {
      const parsed = JSON.parse(json) as { edits?: unknown };
      if (!parsed || !Array.isArray(parsed.edits)) return [];
      return parsed.edits.filter(
        (e): e is PolishEdit =>
          !!e &&
          typeof (e as PolishEdit).find === 'string' &&
          typeof (e as PolishEdit).replace === 'string' &&
          (e as PolishEdit).find.length > 0,
      );
    } catch {
      return [];
    }
  },

  /**
   * Apply edits to the chapter. Each edit replaces the FIRST occurrence of its
   * `find` span; an edit whose `find` is absent is skipped (the model may have
   * paraphrased it). Returns the new text plus counts for observability.
   */
  applyEdits(content: string, edits: PolishEdit[]): { text: string; applied: number; skipped: number } {
    let text = content;
    let applied = 0;
    let skipped = 0;
    for (const edit of edits) {
      const idx = text.indexOf(edit.find);
      if (idx === -1) {
        skipped += 1;
        continue;
      }
      text = text.slice(0, idx) + edit.replace + text.slice(idx + edit.find.length);
      applied += 1;
    }
    return { text, applied, skipped };
  },
};

/** Extract the outermost {...} block, tolerating code fences / leading prose. */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}
