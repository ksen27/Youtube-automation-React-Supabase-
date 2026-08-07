import type { AiContentBlock } from '../ports/services/AiTextGenerator';
import type { ReferenceShot } from '../ports/services/ReferenceScreenshotter';

/**
 * Looks at the layout we just built and says whether it is visually broken.
 *
 * The page contract checks everything mechanical — placeholders present,
 * sections marked, tags balanced, colours from the palette, slots declared and
 * placed. A layout can satisfy all of it and still be unusable: a portrait
 * rendered over the sticky header, a bullet list squeezed into twelve-character
 * columns, a third of a section left empty beside an image. Each of those
 * shipped to the client, and none of them is visible in markup — only once
 * painted.
 *
 * Deliberately narrow. This is a defect check, not a design critique: it is
 * looking for things a person would call broken, because a reviewer that
 * complains about taste would reject good layouts and burn the repair rounds
 * that real faults need.
 */
export const LayoutReviewPrompt = {
  build(input: { shots: ReferenceShot[] }): { system: string; user: AiContentBlock[] } {
    const system = [
      'You are reviewing screenshots of a sales page for LAYOUT DEFECTS. Return ONLY JSON:',
      '  { "ok": boolean, "problems": string[] }',
      '',
      'Report a problem ONLY when a reasonable person would call the page broken:',
      '  - anything overlapping or covering anything else, especially a fixed/sticky',
      '    header sitting over content, or an image on top of text',
      '  - a text column so narrow that words wrap after two or three of them',
      '    (roughly under 20 characters), or headings breaking mid-phrase',
      '  - a large empty region beside content — an unfilled grid column, or a',
      '    section where one side is blank',
      '  - an image at an obviously wrong scale: a portrait or cover dominating the',
      '    viewport, or shrunk to a thumbnail where the design clearly wants it big',
      '  - text clipped, cut off at an edge, or running outside its container',
      '  - text that is unreadable against what is behind it',
      '  - content scrolling sideways, or elements pushed off the right edge',
      '',
      'Do NOT report matters of taste: colour choices, font choices, wording,',
      'section order, spacing you would have set differently, or a design you find',
      'plain. Those are decisions, not defects.',
      '',
      'Each problem must name WHERE it is and WHAT is wrong, specifically enough to',
      'fix without seeing the image — e.g. "the section headed \'Engine, Brakes,',
      'Tires and Filters\' splits its bullet list into two columns about 12',
      'characters wide, so every bullet wraps after two words". Vague reports are',
      'worse than none.',
      '',
      'If the page looks fine, return { "ok": true, "problems": [] }.',
    ].join('\n');

    return {
      system,
      user: [
        {
          type: 'text',
          text:
            `These ${input.shots.length} screenshots are one generated sales page, top to bottom, ` +
            'at 1280px wide. The placeholder text is filler sized to each slot, so judge the ' +
            'LAYOUT and not the words.',
        },
        ...input.shots.map((shot) => ({
          type: 'image' as const,
          mediaType: shot.mediaType,
          dataBase64: shot.dataBase64,
        })),
      ],
    };
  },
};
