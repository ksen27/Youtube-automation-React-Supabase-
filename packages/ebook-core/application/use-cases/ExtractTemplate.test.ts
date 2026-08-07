import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseJsonCompletion } from '../prompts/parse';

/**
 * The annotation response shape, mirrored here so the tolerance rules can be
 * exercised without standing up the whole use case.
 *
 * Every one of these cases cost a real extraction run. The model's answer is
 * advisory in every field that is not an id, and nothing downstream trusts it —
 * ids that name no node are dropped, the checkout guard runs regardless, and
 * `validateTemplate` still refuses a template missing a required placeholder.
 * So the schema's job is to let a slightly-off answer through, not to police it.
 */
const AnnotationEntry = z.object({
  nodeId: z.string(),
  placeholder: z.string(),
  maxChars: z.number().nullish(),
});

function lenientArray<S extends z.ZodTypeAny>(item: S) {
  return z
    .array(z.unknown())
    .default([])
    .transform((rows) =>
      rows
        .map((row) => item.safeParse(row))
        .filter((r): r is { success: true; data: z.output<S> } => r.success)
        .map((r) => r.data),
    );
}

const AnnotationSchema = z.object({
  map: lenientArray(AnnotationEntry),
  repeaters: lenientArray(z.object({ containerTplId: z.string(), key: z.string() })),
});

const parse = (text: string) => parseJsonCompletion(text, AnnotationSchema);

describe('the annotation response schema', () => {
  it('accepts a well-formed answer', () => {
    const result = parse('{"map":[{"nodeId":"n17","placeholder":"HERO_TITLE","maxChars":34}],"repeaters":[]}');
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.map).toHaveLength(1);
  });

  /**
   * The failure that killed revision 5. `optional()` permits `undefined` but
   * not `null`, and the model returns an explicit null when it has no opinion —
   * four of them in a fourteen-entry map, for a field that is measured from the
   * node's own text anyway.
   */
  it('accepts a null maxChars, which the model returns when it has no opinion', () => {
    const result = parse('{"map":[{"nodeId":"n17","placeholder":"HERO_TITLE","maxChars":null}]}');
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.map[0]?.maxChars).toBeNull();
  });

  it('accepts an omitted maxChars', () => {
    const result = parse('{"map":[{"nodeId":"n17","placeholder":"HERO_TITLE"}]}');
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.map).toHaveLength(1);
  });

  // One bad row out of forty must not discard the other thirty-nine. A dropped
  // entry costs one unlabelled node — visible and fixable. A rejected response
  // costs the whole run and lands the seller on the built-in template.
  it('drops a malformed entry instead of failing the whole response', () => {
    const result = parse(
      '{"map":[' +
        '{"nodeId":"n1","placeholder":"HERO_TITLE","maxChars":30},' +
        '{"placeholder":"HERO_SUBTITLE"},' +
        '{"nodeId":"n3","placeholder":"CTA_TEXT","maxChars":null}' +
        ']}',
    );
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.map.map((e) => e.nodeId)).toEqual(['n1', 'n3']);
  });

  it('drops a malformed repeater without losing the good ones', () => {
    const result = parse('{"map":[],"repeaters":[{"containerTplId":"n9","key":"BENEFITS"},{"key":"FAQ_ITEMS"}]}');
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.repeaters).toEqual([{ containerTplId: 'n9', key: 'BENEFITS' }]);
  });

  it('defaults both arrays when the model omits them entirely', () => {
    const result = parse('{}');
    if (result.isFail()) throw new Error(result.error);
    expect(result.value).toEqual({ map: [], repeaters: [] });
  });

  // Tolerance is not blindness: a response that is not the required shape at
  // all still fails, and the run retries with the reason.
  it('still rejects a response that is not an object', () => {
    expect(parse('[1, 2, 3]').isFail()).toBe(true);
  });
});
